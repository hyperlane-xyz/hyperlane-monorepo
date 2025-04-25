use async_trait::async_trait;
use derive_new::new;
use ethers::utils::hex;
use reqwest;
use serde::Deserialize;
use serde_json::json;
use tracing::{debug, instrument};

use hyperlane_core::{HyperlaneMessage, H256};

use super::{
    base::MessageMetadataBuildParams, utils::fetch_fsr_config, MessageMetadataBuilder, Metadata,
    MetadataBuildError, MetadataBuilder,
};

/// Provider type for Polymer
const POLYMER_PROVIDER_TYPE: &str = "polymer";

/// FSR response schema matching the TypeScript definition from polymer.ts
#[derive(Debug, Deserialize)]
struct FSRResponse {
    result: String, // The original directive hex string
    proof: String,  // The proof from Polymer
}

#[derive(new, Clone, Debug)]
pub struct PolymerMetadataBuilder {
    base: MessageMetadataBuilder,
}

#[async_trait]
impl MetadataBuilder for PolymerMetadataBuilder {
    #[instrument(err, skip(self, message), ret)]
    async fn build(
        &self,
        _ism_address: H256,
        message: &HyperlaneMessage,
        _params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        // TODO: We probably don't want to fetch the FSR config every time.
        // The FSR server url is shared across all FSR providers.
        // Fetch FSR config
        let fsr_config = fetch_fsr_config()
            .await
            .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?;

        // Create FSR request
        let request = json!({
            "providerType": POLYMER_PROVIDER_TYPE,
            "directive": hex::encode(&message.body)
        });

        // Send request to FSR server
        let client = reqwest::Client::new();
        let response = client
            .post(&fsr_config.fsr_server_url)
            .json(&request)
            .send()
            .await
            .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?;

        let fsr_response = response
            .json::<FSRResponse>()
            .await
            .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?;

        debug!(
            message_id = ?message.id(),
            "Successfully fetched proof from FSR service"
        );

        // Convert the proof to a Vec<u8> and create the Metadata
        let proof_bytes = hex::decode(&fsr_response.proof)
            .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?;
        Ok(Metadata::new(proof_bytes))
    }
}
