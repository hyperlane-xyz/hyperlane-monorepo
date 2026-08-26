use std::env;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use hyperlane_core::ChainResult;
use serde_json::{json, Value};
use sov_universal_wallet::schema::{chain_hash_fragment, RollupRoots};

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
        let chain_hash = self.transaction_chain_hash()?;
        let utx = self.build_tx_json(&call_message, &chain_hash);

        let tx = self.sign_tx(utx, &self.signer, chain_hash).await?;
        let body = self.serialize_tx(&tx).await?;
        let response = self.submit_tx(body.clone()).await?;

        Ok((response, body))
    }

    fn build_tx_json(&self, call_message: &Value, chain_hash: &[u8; 32]) -> Value {
        json!({
            "runtime_call": call_message,
            "uniqueness": {
                "generation": self.get_generation(),
            },
            "details": {
                "max_priority_fee_bips": 0,
                "max_fee": 100_000_000,
                "gas_limit": Value::Null,
                "chain_hash_fragment": chain_hash_fragment(chain_hash).to_string()
            },
            "address_override": Value::Null,
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

    fn transaction_chain_hash(&self) -> ChainResult<[u8; 32]> {
        // test runtime in sovereign sdk hardcodes chain hash to this value
        // https://github.com/Sovereign-Labs/sovereign-sdk/blob/b0676ef28700dd1b3d2c21711c701164b0553d4a/crates/utils/sov-test-utils/src/runtime/macros.rs#L124
        if env::var("SOV_TEST_UTILS_FIXED_CHAIN_HASH").is_ok() {
            Ok([11; 32])
        } else {
            self.schema
                .chain_hash()
                .map_err(|e| custom_err!("Failed to get chain hash: {e}"))
        }
    }

    async fn sign_tx(
        &self,
        mut utx_json: Value,
        signer: &impl Crypto,
        chain_hash: [u8; 32],
    ) -> ChainResult<Value> {
        tracing::trace!(?utx_json, "Signing transaction");
        let utx_index = self
            .schema
            .rollup_expected_index(RollupRoots::TransactionSigningPayload)
            .map_err(|e| custom_err!("Failed searching unsigned transaction schema: {e}"))?;

        let mut signing_payload_json = utx_json.clone();
        if let Some(obj) = signing_payload_json.as_object_mut() {
            obj.insert("chain_hash".to_string(), serde_json::to_value(chain_hash)?);
        }
        let utx_versioned_json = json!({ "V0": signing_payload_json });
        let utx_bytes = self
            .schema
            .json_to_borsh(utx_index, &utx_versioned_json.to_string())
            .map_err(|e| custom_err!("Failed serializing unsigned transaction: {e}"))?;

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
