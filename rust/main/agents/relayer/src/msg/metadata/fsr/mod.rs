use std::sync::Arc;

use async_trait::async_trait;
use ethers::utils::hex;
use reqwest;
use serde::Deserialize;
use serde_json::json;
use tracing::{debug, instrument};

use hyperlane_core::{HyperlaneMessage, H256};

use crate::msg::metadata::base_builder::BuildsBaseMetadata;

use super::base::MessageBodyBuilder;
use super::{utils::fetch_fsr_config, Metadata, MetadataBuildError};

/// FSR response schema matching the TypeScript definition from polymer.ts
#[derive(Debug, Deserialize)]
struct FSRResponse {
    result: String, // The original directive hex string
    proof: String,  // The proof from Polymer
}

#[derive(Clone, Debug)]
pub struct FSRMetadataBuilder {
    base: Arc<dyn BuildsBaseMetadata>,
    app_context: Option<String>,
}

impl FSRMetadataBuilder {
    pub async fn new(
        base: Arc<dyn BuildsBaseMetadata>,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> Result<Self, MetadataBuildError> {
        let app_context = base
            .app_context_classifier()
            .get_app_context(message, ism_address)
            .await
            .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?;
        Ok(Self { base, app_context })
    }
}

#[async_trait]
impl MessageBodyBuilder for FSRMetadataBuilder {
    #[instrument(err, skip(self, message), ret)]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> Result<(Metadata, Vec<u8>), MetadataBuildError> {
        // Get the ISM module type
        let ism = self
            .base
            .build_ism(ism_address)
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

        let module_type = self.base.call_module_type(&ism).await?;

        // TODO: We may not want to fetch the FSR config every time.
        // Fetch FSR config
        let fsr_config = fetch_fsr_config()
            .await
            .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?;

        // Create FSR request
        let request = json!({
            "ismModuleType": module_type.to_string(),
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

        let result_bytes = hex::decode(&fsr_response.result)
            .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?;

        Ok((Metadata::new(proof_bytes), result_bytes))
    }
}
