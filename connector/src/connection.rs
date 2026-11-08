use std::sync::Arc;
use std::time::Duration;

use ed25519_dalek::SigningKey;
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{Instant, interval_at, sleep, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};

use crate::config::Config;
use crate::database::Database;
use crate::envelope::{self, Gateway, Opened, Responder};
use crate::messages::{self, Request, Response};
use crate::pairing::PairingCode;
use crate::relay::{
    self, Close, ConnectorMessage, Enroll, Enrolled, Hello, KeyConfig, Rejection, RelayMessage,
    connector_message, rejection, relay_message, response,
};
use crate::state::State;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const READ_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_FRAME_SIZE: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("invalid frame from relay")]
    Decode(#[from] prost::DecodeError),
    #[error(transparent)]
    Envelope(#[from] envelope::Error),
    #[error("relay stopped responding")]
    Timeout(#[from] tokio::time::error::Elapsed),
    #[error("relay closed the connection")]
    Closed,
    #[error("relay refused the connector ({}): {}", .0.reason().as_str_name(), .0.detail)]
    Refused(Close),
}

pub async fn enroll(
    config: &Config,
    identity: &SigningKey,
    code: &PairingCode,
) -> Result<String, Error> {
    let mut socket = open(config).await?;
    let identity_key = identity.verifying_key();
    send(
        &mut socket,
        connector_message::Message::Enroll(Enroll {
            connector_id: config.connector_id.to_string(),
            enrollment_token: code.enrollment_token.clone(),
            identity_key: identity_key.to_bytes().to_vec(),
            proof: code.proof(config.connector_id, &identity_key).to_vec(),
        }),
    )
    .await?;
    loop {
        match receive(&mut socket).await? {
            Some(relay_message::Message::Enrolled(Enrolled { token })) => return Ok(token),
            Some(relay_message::Message::Close(close)) => return Err(Error::Refused(close)),
            _ => {}
        }
    }
}

pub async fn run(config: &Config, state: &State, token: &str, database: Arc<Database>) -> Close {
    let mut backoff = Backoff::default();
    loop {
        let session = async {
            Session::connect(config, state, token, database.clone())
                .await?
                .run(&mut backoff)
                .await
        };
        match session.await {
            Ok(close) => return close,
            Err(error) => eprintln!("Disconnected from relay: {error}"),
        }
        backoff.wait().await;
    }
}

struct Backoff(Duration);

impl Backoff {
    const MIN: Duration = Duration::from_secs(1);
    const MAX: Duration = Duration::from_secs(60);

    fn reset(&mut self) {
        self.0 = Self::MIN;
    }

    async fn wait(&mut self) {
        sleep(self.0.mul_f64(rand::random_range(0.5..1.0))).await;
        self.0 = (self.0 * 2).min(Self::MAX);
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Self(Self::MIN)
    }
}

struct Session {
    socket: Socket,
    gateway: Gateway,
    database: Arc<Database>,
}

struct Handled {
    request_id: u64,
    responder: Responder,
    response: Response,
}

impl Session {
    async fn connect(
        config: &Config,
        state: &State,
        token: &str,
        database: Arc<Database>,
    ) -> Result<Self, Error> {
        let mut session = Self {
            socket: open(config).await?,
            gateway: Gateway::new(
                state.identity.clone(),
                config.connector_id,
                state.users.clone(),
            ),
            database,
        };
        session
            .send(connector_message::Message::Hello(Hello {
                connector_version: env!("CARGO_PKG_VERSION").into(),
                connector_id: config.connector_id.to_string(),
                token: token.into(),
            }))
            .await?;
        Ok(session)
    }

    async fn run(mut self, backoff: &mut Backoff) -> Result<Close, Error> {
        let (handled_tx, mut handled_rx) = mpsc::unbounded_channel();
        let mut rotation = interval_at(Instant::now() + Gateway::ROTATION, Gateway::ROTATION);
        loop {
            tokio::select! {
                message = receive(&mut self.socket) => match message? {
                    Some(relay_message::Message::Welcome(_)) => {
                        self.publish_key_config().await?;
                        eprintln!("Connected to relay");
                        backoff.reset();
                    }
                    Some(relay_message::Message::Close(close)) => return Ok(close),
                    Some(relay_message::Message::Request(request)) => {
                        self.accept(request, &handled_tx).await?;
                    }
                    Some(relay_message::Message::Enrolled(_)) | None => {}
                },
                Some(Handled { request_id, responder, response }) = handled_rx.recv() => {
                    let sealed = responder.seal(&response)?;
                    self.respond(request_id, response::Result::Sealed(sealed)).await?;
                }
                _ = rotation.tick() => {
                    self.gateway.rotate();
                    self.publish_key_config().await?;
                }
            }
        }
    }

    async fn accept(
        &mut self,
        request: relay::Request,
        handled_tx: &mpsc::UnboundedSender<Handled>,
    ) -> Result<(), Error> {
        let Opened {
            responder,
            envelope,
        } = match self.gateway.open::<Value>(&request.sealed) {
            Ok(opened) => opened,
            Err(error) => {
                let rejection = response::Result::Rejection(Rejection::from(&error));
                return self.respond(request.id, rejection).await;
            }
        };
        let envelope = match envelope {
            Ok(envelope) => envelope,
            Err(refusal) => {
                let sealed = responder.seal(&refusal)?;
                return self
                    .respond(request.id, response::Result::Sealed(sealed))
                    .await;
            }
        };
        let database = self.database.clone();
        let handled_tx = handled_tx.clone();
        tokio::spawn(async move {
            let response = match serde_json::from_value::<Request>(envelope.body) {
                Ok(body) => messages::handle(&database, body).await,
                Err(error) => Response::Error {
                    message: error.to_string(),
                },
            };
            let _ = handled_tx.send(Handled {
                request_id: request.id,
                responder,
                response,
            });
        });
        Ok(())
    }

    async fn publish_key_config(&mut self) -> Result<(), Error> {
        let signed = self.gateway.key_config();
        let key_config = KeyConfig {
            config: signed.config.clone(),
            signature: signed.signature.to_bytes().to_vec(),
        };
        self.send(connector_message::Message::KeyConfig(key_config))
            .await
    }

    async fn respond(&mut self, request_id: u64, result: response::Result) -> Result<(), Error> {
        let response = relay::Response {
            request_id,
            result: Some(result),
        };
        self.send(connector_message::Message::Response(response))
            .await
    }

    async fn send(&mut self, message: connector_message::Message) -> Result<(), Error> {
        send(&mut self.socket, message).await
    }
}

async fn open(config: &Config) -> Result<Socket, Error> {
    let websocket_config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME_SIZE))
        .max_frame_size(Some(MAX_FRAME_SIZE));
    let (socket, _) =
        connect_async_with_config(&config.relay_url, Some(websocket_config), false).await?;
    Ok(socket)
}

async fn send(socket: &mut Socket, message: connector_message::Message) -> Result<(), Error> {
    let frame = ConnectorMessage {
        message: Some(message),
    };
    Ok(socket
        .send(Message::Binary(frame.encode_to_vec().into()))
        .await?)
}

async fn receive(socket: &mut Socket) -> Result<Option<relay_message::Message>, Error> {
    loop {
        if let Message::Binary(data) = timeout(READ_TIMEOUT, socket.next())
            .await?
            .ok_or(Error::Closed)??
        {
            return Ok(RelayMessage::decode(data)?.message);
        }
    }
}

impl From<&envelope::Error> for Rejection {
    fn from(error: &envelope::Error) -> Self {
        let reason = match error {
            envelope::Error::StaleKey => rejection::Reason::StaleKey,
            envelope::Error::Unauthorized => rejection::Reason::Unauthorized,
            envelope::Error::Undecryptable => rejection::Reason::Undecryptable,
            envelope::Error::Malformed
            | envelope::Error::Compression(_)
            | envelope::Error::Json(_) => rejection::Reason::Malformed,
        };
        Self {
            reason: reason.into(),
        }
    }
}
