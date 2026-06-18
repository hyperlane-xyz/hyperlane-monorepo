use async_trait::async_trait;
use derive_more::Deref;
use futures_util::future::join_all;
use futures_util::stream::{FuturesUnordered, StreamExt};

use derive_new::new;
use tracing::{debug, info, instrument};
use {hyperlane_base::cache::FunctionCallCache, tracing::warn};

use hyperlane_core::{
    AggregationIsm, HyperlaneMessage, InterchainSecurityModule, Metadata, ModuleType, H256, U256,
};

use crate::msg::metadata::{
    base::{MetadataBuildError, MetadataBuildRefused},
    message_builder,
};

use super::{IsmCachePolicy, MessageMetadataBuildParams, MessageMetadataBuilder, MetadataBuilder};

/// Bytes used to store one member of the (start, end) range tuple
/// Copied from `AggregationIsmMetadata.sol`
const METADATA_RANGE_SIZE: usize = 4;

#[derive(Clone, Debug, new, Deref)]
pub struct AggregationIsmMetadataBuilder {
    base: MessageMetadataBuilder,
}

#[derive(Clone, Debug, new, PartialEq, Eq)]
struct SubModuleMetadata {
    /// The index of the sub-module (ISM) in the aggregation ISM.
    index: usize,
    /// The metadata for the sub-module.
    metadata: Metadata,
}

/// Result of building and verifying a single aggregation sub-module.
enum ModuleBuildOutcome {
    /// Build was explicitly refused (e.g. recursion limit).
    Refused(MetadataBuildRefused),
    /// Build failed because validator signatures aren't collected yet.
    AwaitingSignatures,
    /// Build failed for another reason, or dry_run_verify returned None/Err.
    Failed,
    /// Built successfully and passed dry_run_verify with the given gas estimate.
    Verified(SubModuleMetadata, U256),
}

impl AggregationIsmMetadataBuilder {
    fn format_metadata(metadatas: &mut [SubModuleMetadata], ism_count: usize) -> Vec<u8> {
        // See test solidity implementation of this fn at:
        // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/445da4fb0d8140a08c4b314e3051b7a934b0f968/solidity/test/isms/AggregationIsm.t.sol#L35
        fn encode_byte_index(i: usize) -> [u8; 4] {
            (i as u32).to_be_bytes()
        }
        let range_tuples_size = METADATA_RANGE_SIZE
            .saturating_mul(2)
            .saturating_mul(ism_count);
        //  Format of metadata:
        //  [????:????] Metadata start/end uint32 ranges, packed as uint64
        //  [????:????] ISM metadata, packed encoding
        // Initialize the range tuple part of the buffer, so the actual metadatas can
        // simply be appended to it
        let mut buffer = vec![0; range_tuples_size];
        for SubModuleMetadata { index, metadata } in metadatas.iter_mut() {
            let range_start = buffer.len();
            buffer.extend_from_slice(metadata.as_ref());
            let range_end = buffer.len();

            // The new tuple starts at the end of the previous ones.
            // Also see: https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/445da4fb0d8140a08c4b314e3051b7a934b0f968/solidity/contracts/libs/isms/AggregationIsmMetadata.sol#L49
            let encoded_range_start = METADATA_RANGE_SIZE.saturating_mul(2).saturating_mul(*index);
            // Overwrite the 0-initialized buffer
            buffer.splice(
                encoded_range_start
                    ..encoded_range_start.saturating_add(METADATA_RANGE_SIZE.saturating_mul(2)),
                [encode_byte_index(range_start), encode_byte_index(range_end)].concat(),
            );
        }
        buffer
    }

    /// Returns modules and threshold from the aggregation ISM.
    /// This method will attempt to get the value from cache first. If it is a cache miss,
    /// it will request it from the ISM contract. The result will be cached for future use.
    ///
    /// Implicit contract in this method: function name `modules_and_threshold` matches
    /// the name of the method `modules_and_threshold`.
    async fn call_modules_and_threshold(
        &self,
        ism: Box<dyn AggregationIsm>,
        message: &HyperlaneMessage,
    ) -> Result<(Vec<H256>, u8), MetadataBuildError> {
        let ism_domain = ism.domain().name();
        let fn_key = "modules_and_threshold";

        // Depending on the cache policy, make use of the message ID
        let params_cache_key = match self
            .base_builder()
            .ism_cache_policy_classifier()
            .get_cache_policy(
                self.root_ism,
                ism.domain(),
                ModuleType::Aggregation,
                self.base.app_context.as_ref(),
            )
            .await
        {
            // To have the cache key be more succinct, we use the message id
            IsmCachePolicy::MessageSpecific => (ism.address(), message.id()),
            IsmCachePolicy::IsmSpecific => (ism.address(), H256::zero()),
        };

        let cache_result = self
            .base_builder()
            .cache()
            .get_cached_call_result::<(Vec<H256>, u8)>(ism_domain, fn_key, &params_cache_key)
            .await
            .map_err(|err| {
                warn!(error = %err, "Error when caching call result for {:?}", fn_key);
            })
            .ok()
            .flatten();

        match cache_result {
            Some(result) => Ok(result),
            None => {
                let result = ism
                    .modules_and_threshold(message)
                    .await
                    .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

                self.base_builder()
                    .cache()
                    .cache_call_result(ism_domain, fn_key, &params_cache_key, &result)
                    .await
                    .map_err(|err| {
                        warn!(error = %err, "Error when caching call result for {:?}", fn_key);
                    })
                    .ok();
                Ok(result)
            }
        }
    }

    async fn try_build_fast_path(
        &self,
        message: &HyperlaneMessage,
        params: MessageMetadataBuildParams,
        threshold: usize,
        ism_addresses: Vec<H256>,
    ) -> Result<Option<Metadata>, MetadataBuildError> {
        if threshold > 1 {
            debug!(
                ?threshold,
                reason = "Aggregation ISM threshold > 1",
                "Fast path is not available"
            );
            return Ok(None);
        }
        let Some((
            message_id_multisig_ism_index,
            message_id_multisig_ism,
            message_id_multisig_ism_address,
        )) = self
            .try_find_message_id_multisig_ism(ism_addresses.clone())
            .await
        else {
            debug!(
                ?threshold,
                reason = "Aggregation ISM does not have a MessageIdMultisig submodule",
                "Fast path is not available"
            );
            return Ok(None);
        };
        let metadata = self
            .build_message_id_aggregation_metadata(
                message,
                params.clone(),
                message_id_multisig_ism,
                message_id_multisig_ism_index,
                message_id_multisig_ism_address,
                ism_addresses.len(),
            )
            .await?;

        Ok(Some(metadata))
    }

    async fn try_find_message_id_multisig_ism(
        &self,
        ism_addresses: Vec<H256>,
    ) -> Option<(usize, Box<dyn InterchainSecurityModule>, H256)> {
        let sub_isms = join_all(ism_addresses.iter().map(|sub_ism_address| async {
            let ism_and_module_type =
                message_builder::ism_and_module_type(self.base.clone(), *sub_ism_address).await;
            (ism_and_module_type, *sub_ism_address)
        }))
        .await;
        sub_isms.into_iter().enumerate().find_map(|(index, ism)| {
            if let (Ok((ism, ModuleType::MessageIdMultisig)), address) = ism {
                Some((index, ism, address))
            } else {
                None
            }
        })
    }

    async fn build_message_id_aggregation_metadata(
        &self,
        message: &HyperlaneMessage,
        params: MessageMetadataBuildParams,
        ism: Box<dyn InterchainSecurityModule>,
        ism_index: usize,
        ism_address: H256,
        ism_count: usize,
    ) -> Result<Metadata, MetadataBuildError> {
        let sub_module_and_meta = message_builder::build_message_metadata(
            self.base.clone(),
            ism_address,
            message,
            params.clone(),
            Some((ism, ModuleType::MessageIdMultisig)),
        )
        .await?;

        let metadata = sub_module_and_meta.metadata;

        // return an error if delivering with this metadata fails
        if sub_module_and_meta
            .ism
            .dry_run_verify(message, &metadata)
            .await
            .map_err(|err| MetadataBuildError::FastPathError(err.to_string()))?
            .is_none()
        {
            return Err(MetadataBuildError::FastPathError(
                "Fast path metadata failed dry run (returned None)".to_string(),
            ));
        }
        let sub_module_metadata = SubModuleMetadata::new(ism_index, metadata);
        let metadata = Metadata::new(Self::format_metadata(&mut [sub_module_metadata], ism_count));
        Ok(metadata)
    }
}

#[async_trait]
impl MetadataBuilder for AggregationIsmMetadataBuilder {
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    #[instrument(err, skip(self, message, params))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        let ism = self
            .base_builder()
            .build_aggregation_ism(ism_address)
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

        let (ism_addresses, threshold) = self.call_modules_and_threshold(ism, message).await?;

        let threshold = threshold as usize;

        match self
            .try_build_fast_path(message, params.clone(), threshold, ism_addresses.clone())
            .await
        {
            Ok(Some(metadata)) => {
                info!("Built metadata using fast path");
                return Ok(metadata);
            }
            Err(MetadataBuildError::Refused(reason)) => {
                return Err(MetadataBuildError::Refused(reason));
            }
            Err(err) => {
                warn!(
                    ?err,
                    "Fast path failed, falling back to the other submodules in the aggregation ISM"
                );
            }
            _ => {
                // The fast path is not available, a debug log has already been printed so try the slow path
            }
        }

        // Build and dry_run_verify submodule metadatas concurrently, stopping as soon
        // as threshold modules pass both steps. Pipelining dry_run_verify inside each
        // future means a module that builds but fails verification doesn't count toward
        // threshold — we keep collecting until we have enough confirmed-valid candidates.
        let mut pending: FuturesUnordered<_> = ism_addresses
            .iter()
            .enumerate()
            .map(|(index, sub_ism_address)| {
                let base = self.base.clone();
                let params = params.clone();
                let addr = *sub_ism_address;
                async move {
                    let build_result =
                        message_builder::build_message_metadata(base, addr, message, params, None)
                            .await;
                    let outcome = match build_result {
                        Err(MetadataBuildError::Refused(reason)) => {
                            ModuleBuildOutcome::Refused(reason)
                        }
                        Err(MetadataBuildError::AwaitingValidatorSignatures) => {
                            ModuleBuildOutcome::AwaitingSignatures
                        }
                        Err(_) => ModuleBuildOutcome::Failed,
                        Ok(sub) => {
                            match sub.ism.dry_run_verify(message, &sub.metadata).await {
                                Ok(Some(gas)) => ModuleBuildOutcome::Verified(
                                    SubModuleMetadata::new(index, sub.metadata),
                                    gas,
                                ),
                                // dry_run returned None (already delivered) or Err
                                _ => ModuleBuildOutcome::Failed,
                            }
                        }
                    };
                    (addr, outcome)
                }
            })
            .collect();

        let mut metas_and_gas: Vec<(SubModuleMetadata, U256)> = Vec::new();
        let mut err_sub_modules: Vec<(H256, Option<ModuleType>)> = Vec::new();
        let mut has_any_error = false;
        let mut all_errors_awaiting = true;

        while let Some((ism_address, outcome)) = pending.next().await {
            match outcome {
                ModuleBuildOutcome::Refused(reason) => {
                    // First refusal in completion order (not ism_addresses order);
                    // nondeterministic for m > 1 but all refusals are fatal so the
                    // specific message doesn't affect correctness.
                    return Err(MetadataBuildError::Refused(reason));
                }
                ModuleBuildOutcome::AwaitingSignatures => {
                    has_any_error = true;
                    err_sub_modules.push((ism_address, None));
                    // all_errors_awaiting stays true
                }
                ModuleBuildOutcome::Failed => {
                    has_any_error = true;
                    all_errors_awaiting = false;
                    err_sub_modules.push((ism_address, None));
                }
                ModuleBuildOutcome::Verified(meta, gas) => {
                    metas_and_gas.push((meta, gas));
                    if metas_and_gas.len() >= threshold {
                        // Early exit: cancellation is safe (atomic cache writes,
                        // stateless RPCs, per-attempt ism_count). Dropped Refused(Reorg)
                        // futures are harmless — a real reorg either prevents threshold
                        // multisig modules from verifying, or is irrelevant to the
                        // non-multisig path (CCTP, trustedRelayer) that did verify.
                        break;
                    }
                }
            }
        }

        // When every sub-module failure is purely "signatures not yet collected" and we
        // can't reach threshold without them, propagate AwaitingValidatorSignatures so
        // the relayer uses the 1 s fast-path backoff instead of the normal 5 s→… ramp.
        if metas_and_gas.len() < threshold {
            if has_any_error && all_errors_awaiting {
                return Err(MetadataBuildError::AwaitingValidatorSignatures);
            }
            info!(?err_sub_modules, metas_and_gas_count=%metas_and_gas.len(), %threshold, message_id=?message.id(), "Could not fetch all metadata, ISM metadata count did not reach aggregation threshold");
            return Err(MetadataBuildError::AggregationThresholdNotMet(
                threshold as u32,
            ));
        }

        metas_and_gas.sort_by(|(m1, _), (m2, _)| m1.index.cmp(&m2.index));
        let mut valid_metas: Vec<SubModuleMetadata> =
            metas_and_gas.into_iter().map(|(m, _)| m).collect();
        let metadata = Metadata::new(Self::format_metadata(&mut valid_metas, ism_addresses.len()));
        Ok(metadata)
    }
}

#[cfg(test)]
mod test {
    use ethers::utils::hex::FromHex;

    use super::*;

    #[test]
    fn test_format_n_of_n_metadata_works_correctly() {
        let mut metadatas = vec![
            SubModuleMetadata::new(
                0,
                Metadata::from_hex(
                    "290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563",
                )
                .unwrap(),
            ),
            SubModuleMetadata::new(
                1,
                Metadata::from_hex(
                    "510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9",
                )
                .unwrap(),
            ),
            SubModuleMetadata::new(
                2,
                Metadata::from_hex(
                    "356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336",
                )
                .unwrap(),
            ),
        ];
        let expected = Metadata::from_hex("000000180000003800000038000000580000005800000078290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336").unwrap();
        assert_eq!(
            AggregationIsmMetadataBuilder::format_metadata(&mut metadatas, 3),
            *expected
        );
    }

    #[test]
    fn test_format_n_of_m_metadata_works_correctly() {
        // We're passing the metadatas of 4 ISMs (indexes 0, 1, 2, 4) out of 5
        let mut metadatas = vec![
            SubModuleMetadata::new(
                0,
                Metadata::from_hex(
                    "290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563",
                )
                .unwrap(),
            ),
            SubModuleMetadata::new(
                1,
                Metadata::from_hex(
                    "510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9",
                )
                .unwrap(),
            ),
            SubModuleMetadata::new(
                2,
                Metadata::from_hex(
                    "356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336",
                )
                .unwrap(),
            ),
            SubModuleMetadata::new(
                4,
                Metadata::from_hex(
                    "f2e59013a0a379837166b59f871b20a8a0d101d1c355ea85d35329360e69c000",
                )
                .unwrap(),
            ),
        ];
        let expected = Vec::from_hex("000000280000004800000048000000680000006800000088000000000000000000000088000000a8290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336f2e59013a0a379837166b59f871b20a8a0d101d1c355ea85d35329360e69c000").unwrap();
        assert_eq!(
            AggregationIsmMetadataBuilder::format_metadata(&mut metadatas, 5),
            expected
        );
    }

    #[test]
    fn test_format_empty_metadata_works_correctly() {
        let mut metadatas = vec![SubModuleMetadata::new(0, Metadata::from_hex("").unwrap())];
        let expected = Vec::from_hex("0000000800000008").unwrap();
        assert_eq!(
            AggregationIsmMetadataBuilder::format_metadata(&mut metadatas, 1),
            expected
        );
    }
}
