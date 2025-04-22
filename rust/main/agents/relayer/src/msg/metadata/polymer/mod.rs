use async_trait::async_trait;
use derive_new::new;
use tracing::{debug, instrument};

use hyperlane_core::{HyperlaneMessage, H256};

use super::{
    base::MessageMetadataBuildParams, MessageMetadataBuilder, Metadata, MetadataBuildError,
    MetadataBuilder, utils::parse_directive_to_polymer_request,
};

pub mod polymer;
pub use polymer::PolymerProofProvider;

#[derive(Clone, Debug, new)]
pub struct PolymerMetadataBuilder {
    base: MessageMetadataBuilder,
    proof_provider: PolymerProofProvider,
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
        // Parse the directive into a PolymerProofRequest
        let request = parse_directive_to_polymer_request(message)
            .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?;

        // Fetch the proof from the Polymer proof provider
        let response = self
            .proof_provider
            .fetch_proof(&request)
            .await
            .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?;

        debug!(
            message_id = ?message.id(),
            "Successfully fetched proof from Polymer proof service"
        );

        // Convert the proof to a Vec<u8> and create the Metadata
        let proof_bytes = response.proof.to_vec();
        Ok(Metadata::new(proof_bytes))
    }
} 
