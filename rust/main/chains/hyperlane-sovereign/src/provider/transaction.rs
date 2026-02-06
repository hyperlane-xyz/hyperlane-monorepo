use std::env;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use hyperlane_core::ChainResult;
use serde_json::{json, Value};
use sov_universal_wallet::schema::RollupRoots;

use super::client::SovereignClient;
use crate::signers::Crypto;
use crate::types::SubmitTxResponse;

impl SovereignClient {
    /// Build a transaction and submit it to the rollup.
    ///
    /// Sovereign uses soft confirmations, so we return immediately after the
    /// sequencer accepts the transaction without waiting for processing.
    pub async fn build_and_submit(
        &self,
        call_message: Value,
    ) -> ChainResult<(SubmitTxResponse, String)> {
        let utx = self.build_tx_json(&call_message);

        let tx = self.sign_tx(utx.clone(), &self.signer).await?;
        let body = self.serialize_tx(&tx).await?;
        let response = self.submit_tx(body.clone()).await?;

        Ok((response, body))
    }

    fn build_tx_json(&self, call_message: &Value) -> Value {
        json!({
            "runtime_call": call_message,
            "uniqueness": {
                "generation": self.get_generation(),
            },
            "details": {
                "max_priority_fee_bips": 0,
                "max_fee": 100_000_000,
                "gas_limit": Value::Null,
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

    async fn sign_tx(&self, mut utx_json: Value, signer: &impl Crypto) -> ChainResult<Value> {
        tracing::trace!(?utx_json, "Signing transaction");
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

        let signature = signer.sign(&utx_bytes)?;

        if let Some(obj) = utx_json.as_object_mut() {
            let sig = hex::encode(&signature);
            obj.insert("signature".to_string(), serde_json::to_value(sig)?);

            let pub_key = hex::encode(signer.public_key());
            obj.insert("pub_key".to_string(), serde_json::to_value(pub_key)?);
        }
        tracing::trace!(?utx_json, "Signed tx");
        Ok(utx_json)
    }

    async fn serialize_tx(&self, tx_json: &Value) -> ChainResult<String> {
        let tx_json = json!({
            "V0": tx_json
        });
        tracing::trace!(?tx_json, "Serializing transaction");
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

    async fn submit_tx(&self, tx: String) -> ChainResult<SubmitTxResponse> {
        let data: SubmitTxResponse = self
            .http_post("/sequencer/txs", &json!({ "body": tx }))
            .await?;
        Ok(data)
    }

    /// Get the current 'generation' - the timestamp in seconds suffices;
    /// # Panics
    ///
    /// Will panic if system time is before epoch
    #[must_use]
    pub(crate) fn get_generation(&self) -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Time went backwards")
            .as_millis()
    }
}
