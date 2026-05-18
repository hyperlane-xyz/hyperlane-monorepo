use std::{future::Future, pin::Pin, sync::Arc};

use futures_util::future::join_all;

use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use eyre::Result;
use hyperlane_core::{HyperlaneMessage, Metadata, H256};
use hyperlane_sealevel::{CompositeIsmMetadataSpec, SealevelCompositeIsm};

use super::multisig::{build_from_known_validators, MessageIdMultisigMetadataBuilder};
use crate::msg::metadata::{
    base::{MessageMetadataBuildParams, MetadataBuildError},
    MessageMetadataBuilder, MetadataBuilder,
};

/// Bytes for one (start, end) range entry in aggregation metadata header.
const AGG_RANGE_SIZE: usize = 4;

/// Builds metadata for a Sealevel composite ISM.
///
/// The flow is:
/// 1. Simulate `VerifyMetadataSpec` on the composite ISM program to get the
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

        let relayer_pubkey = self.composite_ism.trusted_relayer_pubkey();
        let bytes = build_metadata_from_spec(&spec, message, &self.base, relayer_pubkey).await?;
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
    relayer_pubkey: Option<H256>,
) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, MetadataBuildError>> + Send + 'a>> {
    Box::pin(build_metadata_from_spec_inner(
        spec,
        message,
        builder,
        relayer_pubkey,
    ))
}

async fn build_metadata_from_spec_inner(
    spec: &CompositeIsmMetadataSpec,
    message: &HyperlaneMessage,
    builder: &MessageMetadataBuilder,
    relayer_pubkey: Option<H256>,
) -> Result<Vec<u8>, MetadataBuildError> {
    match spec {
        CompositeIsmMetadataSpec::Null => Ok(vec![]),

        CompositeIsmMetadataSpec::TrustedRelayer { relayer } => {
            let relayer_h256 = H256::from(relayer.to_bytes());
            if relayer_pubkey == Some(relayer_h256) {
                Ok(vec![])
            } else {
                Err(MetadataBuildError::CouldNotFetch)
            }
        }

        CompositeIsmMetadataSpec::CannotVerify => Err(MetadataBuildError::CouldNotFetch),

        CompositeIsmMetadataSpec::MultisigMessageId {
            validators,
            threshold,
        } => {
            let validators_h256: Vec<H256> = validators.iter().map(|v| (*v).into()).collect();
            let metadata = build_from_known_validators(
                &MessageIdMultisigMetadataBuilder::new(builder.clone()),
                message,
                validators_h256,
                *threshold,
            )
            .await?;
            Ok(metadata.to_owned())
        }

        CompositeIsmMetadataSpec::Aggregation {
            threshold,
            sub_specs,
        } => {
            let ism_count = sub_specs.len();
            let threshold_usize = *threshold as usize;

            // Build metadata for all sub-specs in parallel (join_all), tracking
            // whether each spec is Null.  Null specs return Ok(vec![]) but must not
            // count as real metadata: packing them as non-(0,0) forces the on-chain
            // aggregation verifier to call verify() on every sub-ISM, breaking m-of-n
            // threshold semantics (e.g. a paused Pausable ISM would fail even when
            // another sub-ISM already meets threshold).
            let sub_results_raw: Vec<(bool, Result<Vec<u8>, MetadataBuildError>)> =
                join_all(sub_specs.iter().map(|sub_spec| async move {
                    let is_null = matches!(sub_spec, CompositeIsmMetadataSpec::Null);
                    let result =
                        build_metadata_from_spec(sub_spec, message, builder, relayer_pubkey).await;
                    (is_null, result)
                }))
                .await;

            // Refused (e.g. reorg) is a hard stop — never satisfy threshold with a
            // different branch when a validator has flagged a reorg.
            for (_, result) in sub_results_raw.iter() {
                if let Err(e @ MetadataBuildError::Refused(_)) = result {
                    return Err(e.clone());
                }
            }

            // Flatten non-refusal build/fetch failures to None for threshold selection.
            let sub_results: Vec<(bool, Option<Vec<u8>>)> = sub_results_raw
                .into_iter()
                .map(|(is_null, r)| (is_null, r.ok()))
                .collect();

            // Non-Null successes are prioritised; Null successes are fallback padding.
            let non_null_count = sub_results
                .iter()
                .filter(|(is_null, r)| !is_null && r.is_some())
                .count();
            let null_count = sub_results
                .iter()
                .filter(|(is_null, r)| *is_null && r.is_some())
                .count();
            if non_null_count.saturating_add(null_count) < threshold_usize {
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
                        packed_count = packed_count.saturating_add(1);
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
                            packed_count = packed_count.saturating_add(1);
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
