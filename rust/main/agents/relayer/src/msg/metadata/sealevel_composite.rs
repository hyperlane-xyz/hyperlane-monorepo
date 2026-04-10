use std::{future::Future, pin::Pin, sync::Arc};

use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use eyre::Result;
use hyperlane_core::{HyperlaneMessage, Metadata, H256};
use hyperlane_sealevel::{CompositeIsmMetadataSpec, SealevelCompositeIsm};
use tracing::{debug, info};

use crate::msg::metadata::{
    base::{MessageMetadataBuildParams, MetadataBuildError},
    MessageMetadataBuilder, MetadataBuilder,
};

/// Bytes for one (start, end) range entry in aggregation metadata header.
const AGG_RANGE_SIZE: usize = 4;

/// Builds metadata for a Sealevel composite ISM.
///
/// The flow is:
/// 1. Simulate `GetMetadataSpec` on the composite ISM program to get the
///    resolved [`CompositeIsmMetadataSpec`] tree (routing/amount-routing already
///    resolved inline by the program).
/// 2. Walk the spec tree recursively:
///    - `Null`                → empty bytes
///    - `MultisigMessageId`   → fetch checkpoint + format MessageId multisig bytes
///    - `Aggregation`         → recurse into sub-specs, pack with 8-byte headers
#[derive(Debug, Clone, new, Deref)]
pub struct SealevelCompositeIsmMetadataBuilder {
    #[deref]
    base: MessageMetadataBuilder,
    composite_ism: Arc<SealevelCompositeIsm>,
}

#[async_trait]
impl MetadataBuilder for SealevelCompositeIsmMetadataBuilder {
    async fn build(
        &self,
        _ism_address: H256,
        message: &HyperlaneMessage,
        _params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        let spec = self
            .composite_ism
            .get_metadata_spec(message)
            .await
            .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?;

        let bytes = build_metadata_from_spec(&spec, message, &self.base).await?;
        Ok(Metadata::new(bytes))
    }
}

/// Recursively builds raw metadata bytes for a [`CompositeIsmMetadataSpec`].
///
/// Uses explicit `Box::pin` because the function is recursive.
pub(crate) fn build_metadata_from_spec<'a>(
    spec: &'a CompositeIsmMetadataSpec,
    message: &'a HyperlaneMessage,
    builder: &'a MessageMetadataBuilder,
) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, MetadataBuildError>> + Send + 'a>> {
    Box::pin(build_metadata_from_spec_inner(spec, message, builder))
}

async fn build_metadata_from_spec_inner(
    spec: &CompositeIsmMetadataSpec,
    message: &HyperlaneMessage,
    builder: &MessageMetadataBuilder,
) -> Result<Vec<u8>, MetadataBuildError> {
    match spec {
        CompositeIsmMetadataSpec::Null => Ok(vec![]),

        CompositeIsmMetadataSpec::MultisigMessageId {
            validators,
            threshold,
        } => {
            // Convert H160 validator addresses to H256 (left-padded with zeros).
            let validators_h256: Vec<H256> = validators.iter().map(|v| (*v).into()).collect();

            if validators_h256.is_empty() {
                info!("Composite ISM: no validators in spec");
                return Err(MetadataBuildError::CouldNotFetch);
            }

            let checkpoint_syncer = builder
                .base_builder()
                .build_checkpoint_syncer(message, &validators_h256, builder.app_context.clone())
                .await
                .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?;

            let message_id = message.id();
            let leaf_index = match builder
                .base_builder()
                .get_merkle_leaf_id_by_message_id(message_id)
                .await
                .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?
            {
                Some(idx) => idx,
                None => {
                    debug!(hyp_message = ?message, "Composite ISM: no merkle leaf for message id");
                    return Err(MetadataBuildError::CouldNotFetch);
                }
            };

            let _ = checkpoint_syncer
                .get_validator_latest_checkpoints_and_update_metrics(
                    &validators_h256,
                    builder.base_builder().origin_domain(),
                    builder.base_builder().destination_domain(),
                )
                .await;

            let quorum_checkpoint = match checkpoint_syncer
                .fetch_checkpoint(
                    &validators_h256,
                    *threshold as usize,
                    leaf_index,
                    builder.base_builder().destination_domain(),
                )
                .await
                .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?
            {
                Some(qc) => qc,
                None => {
                    debug!("Composite ISM: no quorum checkpoint found");
                    return Err(MetadataBuildError::CouldNotFetch);
                }
            };

            if quorum_checkpoint.checkpoint.message_id != message_id {
                info!(
                    got = %quorum_checkpoint.checkpoint.message_id,
                    expected = %message_id,
                    "Composite ISM: quorum checkpoint message id mismatch"
                );
                return Err(MetadataBuildError::CouldNotFetch);
            }

            // Format: [hook(32)] [root(32)] [index(4)] [sigs(65 * n)]
            let mut metadata = Vec::with_capacity(
                68_usize.saturating_add(quorum_checkpoint.signatures.len().saturating_mul(65)),
            );
            metadata.extend_from_slice(
                &quorum_checkpoint
                    .checkpoint
                    .merkle_tree_hook_address
                    .to_fixed_bytes(),
            );
            metadata.extend_from_slice(&quorum_checkpoint.checkpoint.root.to_fixed_bytes());
            metadata.extend_from_slice(&quorum_checkpoint.checkpoint.index.to_be_bytes());
            for sig in &quorum_checkpoint.signatures {
                metadata.extend_from_slice(&sig.to_vec());
            }
            Ok(metadata)
        }

        CompositeIsmMetadataSpec::Aggregation {
            threshold,
            sub_specs,
        } => {
            let ism_count = sub_specs.len();
            let threshold_usize = *threshold as usize;

            // Build metadata for each sub-spec, tracking whether the spec is Null.
            // Null specs return Ok(vec![]) but must not count as real metadata: packing
            // them as non-(0,0) forces the on-chain aggregation verifier to call verify()
            // on every sub-ISM, breaking m-of-n threshold semantics (e.g. a paused
            // Pausable ISM would fail even when another sub-ISM already meets threshold).
            let mut sub_results: Vec<(bool, Option<Vec<u8>>)> = Vec::with_capacity(ism_count);
            for sub_spec in sub_specs {
                let is_null = matches!(sub_spec, CompositeIsmMetadataSpec::Null);
                match build_metadata_from_spec(sub_spec, message, builder).await {
                    Ok(bytes) => sub_results.push((is_null, Some(bytes))),
                    Err(_) => sub_results.push((is_null, None)),
                }
            }

            // Non-Null successes are prioritised; Null successes are fallback padding.
            let non_null_count = sub_results
                .iter()
                .filter(|(is_null, r)| !is_null && r.is_some())
                .count();
            let null_count = sub_results
                .iter()
                .filter(|(is_null, r)| *is_null && r.is_some())
                .count();
            if non_null_count + null_count < threshold_usize {
                return Err(MetadataBuildError::CouldNotFetch);
            }

            // Decide which entries to pack:
            //   1. Non-Null successes first (up to threshold).
            //   2. Null successes only if threshold is not yet met.
            //   3. Everything else stays as (0,0) → on-chain verifier skips it.
            let mut packed_count = 0usize;
            let mut final_results: Vec<Option<Vec<u8>>> = vec![None; ism_count];

            for (i, (is_null, result)) in sub_results.iter().enumerate() {
                if packed_count >= threshold_usize {
                    break;
                }
                if !is_null {
                    if let Some(bytes) = result {
                        final_results[i] = Some(bytes.clone());
                        packed_count += 1;
                    }
                }
            }

            if packed_count < threshold_usize {
                for (i, (is_null, result)) in sub_results.iter().enumerate() {
                    if packed_count >= threshold_usize {
                        break;
                    }
                    if *is_null {
                        if let Some(bytes) = result {
                            final_results[i] = Some(bytes.clone());
                            packed_count += 1;
                        }
                    }
                }
            }

            // Pack into aggregation format:
            //   [start_0(4b)][end_0(4b)] ... [start_n(4b)][end_n(4b)] [data_0] [data_1] ...
            // (0,0) means no metadata for that ISM.
            let header_size = AGG_RANGE_SIZE.saturating_mul(2).saturating_mul(ism_count);
            let mut buffer = vec![0u8; header_size];
            for (i, maybe_bytes) in final_results.iter().enumerate() {
                if let Some(bytes) = maybe_bytes {
                    let start = buffer.len() as u32;
                    buffer.extend_from_slice(bytes);
                    let end = buffer.len() as u32;
                    let slot = AGG_RANGE_SIZE.saturating_mul(2).saturating_mul(i);
                    buffer[slot..slot.saturating_add(4)].copy_from_slice(&start.to_be_bytes());
                    buffer[slot.saturating_add(4)..slot.saturating_add(8)]
                        .copy_from_slice(&end.to_be_bytes());
                }
                // else: (0, 0) already initialised by vec![0u8; header_size]
            }
            Ok(buffer)
        }
    }
}
