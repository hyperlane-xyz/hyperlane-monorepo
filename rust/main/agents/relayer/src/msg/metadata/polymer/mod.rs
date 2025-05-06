use async_trait::async_trait;
use derive_new::new;
use tracing::{debug, instrument};

use hyperlane_core::{HyperlaneMessage, H256};

use super::{base::MessageMetadataBuildParams, Metadata, MetadataBuildError, MetadataBuilder};

mod polymer;
pub use polymer::PolymerProofProvider;

#[derive(Clone, Debug, new)]
pub struct PolymerMetadataBuilder {
    proof_provider: PolymerProofProvider,
}

#[async_trait]
impl MetadataBuilder for PolymerMetadataBuilder {
    #[instrument(err, skip(self, message), ret)]
    async fn build(
        &self,
        _ism_address: H256,
        message: &HyperlaneMessage,
        params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        // Get LogMeta from params, required for Polymer proofs
        let log_meta = params.log_meta.ok_or_else(|| {
            MetadataBuildError::FailedToBuild(
                "Missing LogMeta, required for Polymer proof generation".to_string(),
            )
        })?;

        // Extract the chain ID from the message and block/tx/log details from the LogMeta
        let chain_id = message.origin as u64;
        let block_number = log_meta.block_number;
        let tx_index: u32 = log_meta.transaction_index.try_into().map_err(|_| {
            MetadataBuildError::FailedToBuild(format!(
                "Transaction index {} is too large to fit into u32",
                log_meta.log_index
            ))
        })?;
        let log_index: u32 = log_meta.log_index.try_into().map_err(|_| {
            MetadataBuildError::FailedToBuild(format!(
                "Log index {} is too large to fit into u32",
                log_meta.log_index
            ))
        })?;

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

        tracing::info!(
            message_id = ?message.id(),
            "Successfully fetched proof from Polymer proof service"
        );

        // Convert the proof to a Vec<u8> and create the Metadata
        let proof_bytes = response.proof.to_vec();
        Ok(Metadata::new(proof_bytes))
    }
}
