use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use eyre::Context;
use tracing::{debug, instrument};

use hyperlane_core::{HyperlaneMessage, H256};

use super::{
    base::MessageMetadataBuildParams, MessageMetadataBuilder, Metadata, MetadataBuildError,
    MetadataBuilder,
};

mod polymer;
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
        // Extract the chain ID, block number, tx index, and log index from the message
        // These values should be encoded in the message's body or metadata
        let chain_id = message.origin as u64;
        let block_number = 0; // TODO: Get from Log metadata
        let tx_index = 0; // TODO: Get from Log metadata
        let log_index = 0; // TODO: Get from Log metadata

        let request = polymer::PolymerProofRequest {
            chain_id,
            block_number,
            tx_index,
            log_index,
        };

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
