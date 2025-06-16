use std::env;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use futures::stream::BoxStream;
use futures::StreamExt;
use hyperlane_core::{ChainResult, H256};
use serde::Deserialize;
use serde_json::{json, Value};
use sov_universal_wallet::schema::RollupRoots;
use tokio::time::{timeout_at, Instant};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

type WsSubscription<T> = BoxStream<'static, ChainResult<T>>;

use super::client::SovereignClient;
use crate::types::{TxInfo, TxStatus};

impl SovereignClient {
    /// Build a transaction and submit it to the rollup.
    pub async fn build_and_submit(&self, call_message: Value) -> ChainResult<(H256, String)> {
        let utx = self.build_tx_json(&call_message);
        let tx = self.sign_tx(utx).await?;
        let body = self.serialise_tx(&tx).await?;
        let hash = self.submit_tx(body.clone()).await?;
        self.wait_for_tx(hash).await?;

        Ok((hash, body))
    }

    async fn wait_for_tx(&self, tx_hash: H256) -> ChainResult<()> {
        const MAX_WAIT_DURATION: u64 = 300;
        let mut tx_subscription = self.subscribe_to_tx_status_updates(tx_hash).await?;

        let end_wait_time = Instant::now() + Duration::from_secs(MAX_WAIT_DURATION);
        let start_wait = Instant::now();

        while Instant::now() < end_wait_time {
            let tx_info = timeout_at(end_wait_time, tx_subscription.next())
                .await
                .map_err(|_| custom_err!("Confirming transaction timed out"))?
                .ok_or_else(|| custom_err!("Subscription closed unexpectedly"))?
                .map_err(|e| custom_err!("Received stream error: {e:?}"))?;

            match tx_info.status {
                TxStatus::Processed | TxStatus::Finalized => return Ok(()),
                TxStatus::Dropped => return Err(custom_err!("Transaction dropped")),
                _ => continue,
            }
        }
        Err(custom_err!(
            "Giving up waiting for target batch to be published after {:?}",
            start_wait.elapsed()
        ))
    }

    fn build_tx_json(&self, call_message: &Value) -> Value {
        json!({
            "runtime_call": call_message,
            "generation": self.get_generation(),
            "details": {
                "max_priority_fee_bips": 100,
                "max_fee": 100_000_000,
                "gas_limit": serde_json::Value::Null,
                "chain_id": self.chain_id
            }
        })
    }

    /// Query the Universal Wallet for the encoded transaction body.
    pub fn encoded_call_message(&self, call_message: &Value) -> ChainResult<String> {
        let rtc_index = self
            .schema
            .rollup_expected_index(RollupRoots::RuntimeCall)
            .map_err(|e| custom_err!("Failed searching runtime call schema: {e}"))?;
        let bytes = self
            .schema
            .json_to_borsh(rtc_index, &call_message.to_string())
            .map_err(|e| custom_err!("Failed serializing runtime call: {e}"))?;

        Ok(format!("{bytes:?}"))
    }

    async fn sign_tx(&self, mut utx_json: Value) -> ChainResult<Value> {
        let utx_index = self
            .schema
            .rollup_expected_index(RollupRoots::UnsignedTransaction)
            .map_err(|e| custom_err!("Failed searching unsigned transaction schema: {e}"))?;
        let mut utx_bytes = self
            .schema
            .json_to_borsh(utx_index, &utx_json.to_string())
            .map_err(|e| custom_err!("Failed serializing unsigned transaction: {e}"))?;

        // test runtime in sovereign sdk hardcodes chain hash to this value
        // https://github.com/Sovereign-Labs/sovereign-sdk-wip/blob/2fcd88e0a4b57183058f3ec9ebf8925998677d0a/crates/module-system/sov-test-utils/src/runtime/macros.rs#L103
        if env::var("SOV_TEST_UTILS_FIXED_CHAIN_HASH").is_ok() {
            utx_bytes.extend_from_slice(&[11; 32]);
        } else {
            let chain_hash = self
                .schema
                .cached_chain_hash()
                .expect("Chain hash is precomputed on client's creation");
            utx_bytes.extend_from_slice(&chain_hash);
        }

        let signature = self.signer.sign(&utx_bytes);

        if let Some(obj) = utx_json.as_object_mut() {
            obj.insert(
                "signature".to_string(),
                json!({ "msg_sig": signature.to_bytes().to_vec() }),
            );
            obj.insert(
                "pub_key".to_string(),
                json!({
                    "pub_key": self.signer.public_key().to_bytes()
                }),
            );
        }
        Ok(utx_json)
    }

    async fn serialise_tx(&self, tx_json: &Value) -> ChainResult<String> {
        let tx_json = json!({
            "versioned_tx": {
                "V0": tx_json
            }
        });
        let tx_index = self
            .schema
            .rollup_expected_index(RollupRoots::Transaction)
            .map_err(|e| custom_err!("Failed searching transaction schema: {e}"))?;
        let tx_bytes = self
            .schema
            .json_to_borsh(tx_index, &tx_json.to_string())
            .map_err(|e| custom_err!("Failed serializing transaction: {e}"))?;

        Ok(BASE64_STANDARD.encode(&tx_bytes))
    }

    async fn submit_tx(&self, tx: String) -> ChainResult<H256> {
        #[derive(Debug, Deserialize)]
        struct Data {
            id: H256,
        }

        let data: Data = self
            .http_post("/sequencer/txs", &json!({ "body": tx }))
            .await?;

        Ok(data.id)
    }

    /// Subscribe to a websocket for status updates.
    pub async fn subscribe_to_tx_status_updates(
        &self,
        tx_hash: H256,
    ) -> ChainResult<WsSubscription<TxInfo>> {
        self.subscribe_to_ws(&format!("/sequencer/txs/{tx_hash:?}/ws"))
            .await
    }

    async fn subscribe_to_ws<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
    ) -> ChainResult<WsSubscription<T>> {
        let mut url = self
            .url
            .join(path)
            .map_err(|e| custom_err!("Failed creating ws url: {e}"))?;
        url.set_scheme("ws")
            .map_err(|_| custom_err!("Failed changing schema to ws"))?;

        let (ws, _) = connect_async(url.as_str())
            .await
            .map_err(|e| custom_err!("Failed to create websocket connection: {e}"))?;

        Ok(ws
            .filter_map(|msg| async {
                match msg {
                    Ok(Message::Text(text)) => match serde_json::from_str(&text) {
                        Ok(tx_status) => Some(Ok(tx_status)),
                        Err(err) => Some(Err(custom_err!(
                            "failed to deserialize JSON {text} into type: {err}",
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
                    Err(err) => Some(Err(custom_err!("{err}"))),
                }
            })
            .boxed())
    }

    /// Get the current 'generation' - the timestamp in seconds suffices;
    /// # Panics
    ///
    /// Will panic if system time is before epoch
    #[must_use]
    fn get_generation(&self) -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Time went backwards")
            .as_millis()
    }
}
