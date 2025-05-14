use base64::{engine::general_purpose, Engine};
use derive_new::new;
use ethers::types::Bytes;
use eyre::{Result, WrapErr};
use tracing::debug;

/// Message sent to the Polymer proof provider
#[derive(Debug)]
pub struct PolymerProofRequest {
    /// The chain ID of the source chain
    pub chain_id: u64,
    /// The block number of the message
    pub block_number: u64,
    /// The transaction index of the message
    pub tx_index: u32,
    /// The log index of the message
    pub log_index: u32,
}

/// Response from the Polymer proof provider
#[derive(Debug)]
pub struct PolymerProofResponse {
    /// The proof for the message
    pub proof: Bytes,
}

/// Fetches proofs for messages using Polymer's proof service
#[derive(Debug, new, Clone)]
pub struct PolymerProofProvider {
    #[new(default)]
    /// The API token for Polymer
    api_token: String,
    #[new(default)]
    /// The API endpoint for Polymer
    api_endpoint: String,
    #[new(value = "5")]
    /// The maximum number of retries for the proof request
    max_retries: u32,
}

impl Default for PolymerProofProvider {
    fn default() -> Self {
        Self {
            api_token: "b28a24ba-0cb7-4df0-ac9c-8e1430bc1360".to_string(),
            api_endpoint: "https://proof.polymer.zone".to_string(),
            max_retries: 5,
        }
    }
}

impl PolymerProofProvider {
    /// Fetch a proof for a message
    pub async fn fetch_proof(&self, request: &PolymerProofRequest) -> Result<PolymerProofResponse> {
        tracing::info!(
            chain_id = request.chain_id,
            block_number = request.block_number,
            tx_index = request.tx_index,
            log_index = request.log_index,
            "Fetching proof from Polymer proof service"
        );

        // Create the proof API client
        let client = reqwest::Client::new();

        // Request the proof
        let response = client
            .post(&self.api_endpoint)
            .header("Authorization", format!("Bearer {}", self.api_token))
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "log_requestProof",
                "params": [
                    request.chain_id,
                    request.block_number,
                    request.tx_index,
                    request.log_index
                ]
            }))
            .send()
            .await
            .wrap_err("log_requestProof")?;

        let response_json: serde_json::Value = response
            .json()
            .await
            .wrap_err("Failed to parse JSON response for log_requestProof")?;

        let job_id = response_json["result"].as_i64().ok_or_else(|| {
            eyre::eyre!("'result' field is missing or not an i64 in log_requestProof response")
        })?;

        tracing::info!(job_id, "Proof requested");

        // Poll for the proof
        let mut attempts = 0;
        loop {
            let response = client
                .post(&self.api_endpoint)
                .json(&serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "log_queryProof",
                    "params": [job_id]
                }))
                .send()
                .await
                .wrap_err("log_queryProof")?;

            let response_json: serde_json::Value = response
                .json()
                .await
                .wrap_err("Failed to parse JSON response for log_queryProof")?;

            // Extract the nested "result" object
            let result = response_json["result"].as_object().ok_or_else(|| {
                eyre::eyre!("'result' field is missing or not an object in log_queryProof response")
            })?;

            tracing::info!(
                job_id,
                status = ?result["status"],
                "Received proof status response",
            );

            if result["status"] == "ready" || result["status"] == "complete" {
                let proof_str = result["proof"]
                    .as_str()
                    .ok_or_else(|| eyre::eyre!("'proof' field is missing or not a string"))?;
                let proof = general_purpose::STANDARD
                    .decode(proof_str)
                    .wrap_err("Failed to decode base64 proof")?;
                return Ok(PolymerProofResponse {
                    proof: Bytes::from(proof),
                });
            }

            attempts += 1;
            if attempts > self.max_retries {
                return Err(eyre::eyre!("Timeout waiting for proof"));
            }

            tracing::info!(
                job_id,
                attempt = attempts,
                max_retries = self.max_retries,
                "Polling for proof status"
            );

            // TODO: Use exponential backoff.
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        }
    }
}
