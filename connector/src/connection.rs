use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};

use crate::RELAY_PROTOCOL_VERSION;
use crate::config::Config;
use crate::envelope::{self, Channel};
use crate::messages::{self, Request, Response};
use crate::relay::{
    self, Close, ConnectorMessage, Hello, Rejection, RelayMessage, connector_message, rejection,
    relay_message, response,
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

pub async fn run(config: &Config) -> Close {
    let mut backoff = Backoff::default();
    loop {
        let session = async { Session::connect(config).await?.run(&mut backoff).await };
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
    channel: Channel,
}

impl Session {
    const READ_TIMEOUT: Duration = Duration::from_secs(90);
    const MAX_FRAME_SIZE: usize = 1024 * 1024;

    async fn connect(config: &Config) -> Result<Self, Error> {
        let websocket_config = WebSocketConfig::default()
            .max_message_size(Some(Self::MAX_FRAME_SIZE))
            .max_frame_size(Some(Self::MAX_FRAME_SIZE));
        let (socket, _) =
            connect_async_with_config(&config.relay_url, Some(websocket_config), false).await?;
        let mut session = Self {
            socket,
            channel: Channel::new(&config.connector_key, config.connector_id.as_str()),
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
        while let Some(message) = timeout(Self::READ_TIMEOUT, self.socket.next()).await? {
            let Message::Binary(data) = message? else {
                continue;
            };
            match RelayMessage::decode(data)?.message {
                Some(relay_message::Message::Welcome(_)) => {
                    eprintln!("Connected to relay");
                    backoff.reset();
                }
                Some(relay_message::Message::Close(close)) => return Ok(close),
                Some(relay_message::Message::Request(request)) => {
                    let response = relay::Response {
                        request_id: request.id,
                        result: Some(self.respond(&request.sealed)?),
                    };
                    self.send(connector_message::Message::Response(response))
                        .await?;
                }
                None => {}
            }
        }
        Err(Error::Closed)
    }

    fn respond(&mut self, sealed: &[u8]) -> Result<response::Result, envelope::Error> {
        let envelope = match self.channel.open_request::<Value>(sealed) {
            Ok(envelope) => envelope,
            Err(error) => return Ok(response::Result::Rejection(Rejection::from(&error))),
        };
        let response = serde_json::from_value::<Request>(envelope.body).map_or_else(
            |error| Response::Error {
                message: error.to_string(),
            },
            messages::handle,
        );
        Ok(response::Result::Sealed(
            self.channel.seal_response(envelope.id, &response)?,
        ))
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
            envelope::Error::UnsupportedVersion(_) | envelope::Error::Undecryptable => {
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
