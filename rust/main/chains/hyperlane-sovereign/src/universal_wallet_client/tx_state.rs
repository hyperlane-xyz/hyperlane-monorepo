pub type WsSubscription<T> = Result<BoxStream<'static, anyhow::Result<T>>, WsError>;
use crate::universal_wallet_client::UniversalClient;
use futures::stream::BoxStream;
use futures::StreamExt;
use hyperlane_core::H256;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

impl UniversalClient {
    /// Subscribe to a websocket for status updates.
    pub async fn subscribe_to_tx_status_updates(
        &self,
        tx_hash: H256,
    ) -> WsSubscription<crate::universal_wallet_client::types::TxInfo> {
        self.subscribe_to_ws(&format!("/sequencer/txs/{tx_hash:?}/ws"))
            .await
    }

    async fn subscribe_to_ws<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
    ) -> WsSubscription<T> {
        let url = format!("{}{}", self.api_url, path).replace("http://", "ws://");

        let (ws, _) = connect_async(url).await?;

        Ok(ws
            .filter_map(|msg| async {
                match msg {
                    Ok(Message::Text(text)) => match serde_json::from_str(&text) {
                        Ok(tx_status) => Some(Ok(tx_status)),
                        Err(err) => Some(Err(anyhow::anyhow!(
                            "failed to deserialize JSON {} into type: {}",
                            text,
                            err
                        ))),
                    },
                    Ok(Message::Binary(msg)) => {
                        tracing::warn!(
                            ?msg,
                            "Received unsupported binary message from WebSocket connection"
                        );
                        None
                    }
                    // All other kinds of messages are ignored because
                    // `tokio-tungstenite` ought to handle all
                    // meta-communication messages (ping, pong, clonse) for us anyway.
                    Ok(_) => None,
                    // Errors are not handled here but passed to the caller.
                    Err(err) => Some(Err(anyhow::anyhow!("{}", err))),
                }
            })
            .boxed())
    }
}
