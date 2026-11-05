use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{Instant, interval_at, sleep, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};

use crate::RELAY_PROTOCOL_VERSION;
use crate::config::Config;
use crate::database::Database;
use crate::envelope::{self, Channels, Responder};
use crate::messages::{self, Request, Response};
use crate::relay::{
    self, Close, ConnectorMessage, Hello, Prekey, Rejection, RelayMessage, connector_message,
    rejection, relay_message, response,
};

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error(transparent)]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("invalid frame from relay: {0}")]
    Decode(#[from] prost::DecodeError),
    #[error(transparent)]
    Envelope(#[from] envelope::Error),
    #[error("relay stopped responding")]
    Timeout(#[from] tokio::time::error::Elapsed),
    #[error("relay closed the connection")]
    Closed,
}

pub async fn run(config: &Config, database: Arc<Database>) -> Close {
    let mut backoff = Backoff::default();
    loop {
        let session = async {
            Session::connect(config, database.clone())
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
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    channels: Channels,
    database: Arc<Database>,
}

struct Handled {
    request_id: u64,
    responder: Responder,
    response: Response,
}

impl Session {
    const READ_TIMEOUT: Duration = Duration::from_secs(90);
    const MAX_FRAME_SIZE: usize = 1024 * 1024;

    async fn connect(config: &Config, database: Arc<Database>) -> Result<Self, Error> {
        let websocket_config = WebSocketConfig::default()
            .max_message_size(Some(Self::MAX_FRAME_SIZE))
            .max_frame_size(Some(Self::MAX_FRAME_SIZE));
        let (socket, _) =
            connect_async_with_config(&config.relay_url, Some(websocket_config), false).await?;
        let mut session = Self {
            socket,
            channels: Channels::new(config.connector_key, config.connector_id.as_str()),
            database,
        };
        session
            .send(connector_message::Message::Hello(Hello {
                protocol_version: RELAY_PROTOCOL_VERSION,
                connector_version: env!("CARGO_PKG_VERSION").into(),
                connector_id: config.connector_id.clone(),
                token: config.token.clone(),
            }))
            .await?;
        Ok(session)
    }

    async fn run(mut self, backoff: &mut Backoff) -> Result<Close, Error> {
        let (handled_tx, mut handled_rx) = mpsc::unbounded_channel();
        let mut rotation = interval_at(Instant::now() + Channels::ROTATION, Channels::ROTATION);
        loop {
            tokio::select! {
                message = timeout(Self::READ_TIMEOUT, self.socket.next()) => {
                    let Message::Binary(data) = message?.ok_or(Error::Closed)?? else {
                        continue;
                    };
                    match RelayMessage::decode(data)?.message {
                        Some(relay_message::Message::Welcome(_)) => {
                            self.publish_prekey().await?;
                            eprintln!("Connected to relay");
                            backoff.reset();
                        }
                        Some(relay_message::Message::Close(close)) => return Ok(close),
                        Some(relay_message::Message::Request(request)) => {
                            self.accept(request, &handled_tx).await?;
                        }
                        None => {}
                    }
                }
                Some(Handled { request_id, responder, response }) = handled_rx.recv() => {
                    let sealed = responder.seal(&response)?;
                    self.respond(request_id, response::Result::Sealed(sealed)).await?;
                }
                _ = rotation.tick() => {
                    self.channels.rotate();
                    self.publish_prekey().await?;
                }
            }
        }
    }

    async fn accept(
        &mut self,
        request: relay::Request,
        handled_tx: &mpsc::UnboundedSender<Handled>,
    ) -> Result<(), Error> {
        let (envelope, responder) = match self.channels.open::<Value>(&request.sealed) {
            Ok(opened) => opened,
            Err(error) => {
                let rejection = response::Result::Rejection(Rejection::from(&error));
                return self.respond(request.id, rejection).await;
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

    async fn publish_prekey(&mut self) -> Result<(), Error> {
        let prekey = Prekey {
            public_key: self.channels.prekey().to_vec(),
        };
        self.send(connector_message::Message::Prekey(prekey)).await
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
        let frame = ConnectorMessage {
            message: Some(message),
        };
        Ok(self
            .socket
            .send(Message::Binary(frame.encode_to_vec().into()))
            .await?)
    }
}

impl From<&envelope::Error> for Rejection {
    fn from(error: &envelope::Error) -> Self {
        let reason = match error {
            envelope::Error::Expired => rejection::Reason::Expired,
            envelope::Error::Replayed => rejection::Reason::Replayed,
            envelope::Error::StaleKey => rejection::Reason::StaleKey,
            envelope::Error::UnsupportedFrame(_) | envelope::Error::Undecryptable => {
                rejection::Reason::Undecryptable
            }
            envelope::Error::Malformed
            | envelope::Error::Compression(_)
            | envelope::Error::Json(_) => rejection::Reason::Malformed,
        };
        Self {
            reason: reason.into(),
        }
    }
}
