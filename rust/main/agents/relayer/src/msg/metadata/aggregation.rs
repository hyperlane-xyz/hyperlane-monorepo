use async_trait::async_trait;
use derive_more::Deref;
use futures_util::future::join_all;

use derive_new::new;
use itertools::{Either, Itertools};
use tracing::{debug, info, instrument};
use {hyperlane_base::cache::FunctionCallCache, tracing::warn};

use hyperlane_core::{
    AggregationIsm, HyperlaneMessage, InterchainSecurityModule, ModuleType, H256, U256,
};

use crate::msg::metadata::{base::MetadataBuildError, message_builder};

use super::{
    IsmCachePolicy, MessageMetadataBuildParams, MessageMetadataBuilder, Metadata, MetadataBuilder,
};

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
    metadata: Vec<u8>,
}

#[derive(Debug)]
struct IsmAndMetadata {
    ism: Box<dyn InterchainSecurityModule>,
    meta: SubModuleMetadata,
}

impl IsmAndMetadata {
    fn new(ism: Box<dyn InterchainSecurityModule>, index: usize, metadata: Vec<u8>) -> Self {
        Self {
            ism,
            meta: SubModuleMetadata::new(index, metadata),
        }
    }
}

impl AggregationIsmMetadataBuilder {
    fn format_metadata(metadatas: &mut [SubModuleMetadata], ism_count: usize) -> Vec<u8> {
        // See test solidity implementation of this fn at:
        // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/445da4fb0d8140a08c4b314e3051b7a934b0f968/solidity/test/isms/AggregationIsm.t.sol#L35
        fn encode_byte_index(i: usize) -> [u8; 4] {
            (i as u32).to_be_bytes()
        }
        let range_tuples_size = METADATA_RANGE_SIZE * 2 * ism_count;
        //  Format of metadata:
        //  [????:????] Metadata start/end uint32 ranges, packed as uint64
        //  [????:????] ISM metadata, packed encoding
        // Initialize the range tuple part of the buffer, so the actual metadatas can
        // simply be appended to it
        let mut buffer = vec![0; range_tuples_size];
        for SubModuleMetadata { index, metadata } in metadatas.iter_mut() {
            let range_start = buffer.len();
            buffer.append(metadata);
            let range_end = buffer.len();

            // The new tuple starts at the end of the previous ones.
            // Also see: https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/445da4fb0d8140a08c4b314e3051b7a934b0f968/solidity/contracts/libs/isms/AggregationIsmMetadata.sol#L49
            let encoded_range_start = METADATA_RANGE_SIZE * 2 * (*index);
            // Overwrite the 0-initialized buffer
            buffer.splice(
                encoded_range_start..(encoded_range_start + METADATA_RANGE_SIZE * 2),
                [encode_byte_index(range_start), encode_byte_index(range_end)].concat(),
            );
        }
        buffer
    }

    fn n_cheapest_metas(
        mut metas_and_gas: Vec<(SubModuleMetadata, U256)>,
        n: usize,
    ) -> Vec<SubModuleMetadata> {
        // Sort by gas cost in ascending order
        metas_and_gas.sort_by(|(_, gas_1), (_, gas_2)| gas_1.cmp(gas_2));
        // Take the cheapest n (the aggregation ISM threshold)
        let mut cheapest: Vec<_> = metas_and_gas[..n].into();
        // Sort by index in ascending order, to match the order expected by the smart contract
        cheapest.sort_by(|(meta_1, _), (meta_2, _)| meta_1.index.cmp(&meta_2.index));
        cheapest.into_iter().map(|(meta, _)| meta).collect()
    }

    async fn cheapest_valid_metas(
        sub_modules: Vec<IsmAndMetadata>,
        message: &HyperlaneMessage,
        threshold: usize,
        err_isms: Vec<(H256, Option<ModuleType>)>,
    ) -> Result<Vec<SubModuleMetadata>, MetadataBuildError> {
        debug!("Processing message from {} to {}, id: {:?}", message.origin, message.destination, message.id());
        let gas_cost_results: Vec<_> = join_all(
            sub_modules
                .iter()
                .map(|module| module.ism.dry_run_verify(message, &(module.meta.metadata))),
        )
        .await;
        debug!("Full gas cost results: {:#?}", gas_cost_results);
        debug!("Message being processed: id={:?}, origin={}, destination={}", message.id(), message.origin, message.destination);
        // Filter out the ISMs with a gas cost estimate
        let metas_and_gas: Vec<_> = sub_modules
            .into_iter()
            .zip(gas_cost_results.into_iter())
            .filter_map(|(module, gas_cost)| {
                let index = module.meta.index;
                let result = gas_cost.ok().map(|gc| {
                    let gas = gc.unwrap_or_default();
                    debug!("Validator at index {} gas cost: {}", index, gas);
                    (module.meta, gas)
                });
                if result.is_none() {
                    debug!("Validator at index {} failed or returned None", index);
                }
                result
            })
            .collect();

        let metas_and_gas_count = metas_and_gas.len();
        if metas_and_gas_count < threshold {
            info!(?err_isms, %metas_and_gas_count, %threshold, message_id=?message.id(), "Could not fetch all metadata, ISM metadata count did not reach aggregation threshold");
            return Err(MetadataBuildError::AggregationThresholdNotMet(
                threshold as u32,
            ));
        }
        Ok(Self::n_cheapest_metas(metas_and_gas, threshold))
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
        debug!("Searching for message ID multisig ISM among {} addresses", ism_addresses.len());
        let sub_isms = join_all(ism_addresses.iter().map(|sub_ism_address| async {
            let ism_and_module_type =
                message_builder::ism_and_module_type(self.base.clone(), *sub_ism_address).await;
            (ism_and_module_type, *sub_ism_address)
        }))
        .await;
        sub_isms.into_iter().enumerate().find_map(|(index, ism)| {
            if let (Ok((ism, module_type)), address) = ism {
                debug!("Found ISM at index {} with type {:?}", index, module_type);
                if module_type == ModuleType::MessageIdMultisig {
                    debug!("Found message ID multisig ISM at index {}", index);
                    Some((index, ism, address))
                } else {
                    None
                }
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

        let metadata = sub_module_and_meta.metadata.to_vec();

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
    #[instrument(err, skip(self, message), ret)]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
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

        let sub_modules_and_metas = join_all(ism_addresses.iter().map(|sub_ism_address| {
            message_builder::build_message_metadata(
                self.base.clone(),
                *sub_ism_address,
                message,
                params.clone(),
                None,
            )
        }))
        .await;

        // If any inner ISMs are refusing to build metadata, we propagate just the first refusal.
        for sub_module_res in sub_modules_and_metas.iter() {
            if let Err(MetadataBuildError::Refused(s)) = sub_module_res {
                return Err(MetadataBuildError::Refused(s.to_string()));
            }
        }

        // Partitions things into
        // 1. ok_sub_modules: ISMs with valid metadata
        // 2. err_sub_modules: ISMs with invalid metadata
        let (ok_sub_modules, err_sub_modules): (Vec<_>, Vec<_>) = sub_modules_and_metas
            .into_iter()
            .zip(ism_addresses.iter())
            .enumerate()
            .partition_map(|(index, (result, ism_address))| match result {
                Ok(sub_module_and_meta) => Either::Left(IsmAndMetadata::new(
                    sub_module_and_meta.ism,
                    index,
                    sub_module_and_meta.metadata.to_vec(),
                )),
                Err(_) => Either::Right((*ism_address, None)),
            });

        let mut valid_metas =
            Self::cheapest_valid_metas(ok_sub_modules, message, threshold, err_sub_modules).await?;

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
                Vec::from_hex("290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563")
                    .unwrap(),
            ),
            SubModuleMetadata::new(
                1,
                Vec::from_hex("510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9")
                    .unwrap(),
            ),
            SubModuleMetadata::new(
                2,
                Vec::from_hex("356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336")
                    .unwrap(),
            ),
        ];
        let expected = Vec::from_hex("000000180000003800000038000000580000005800000078290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336").unwrap();
        assert_eq!(
            AggregationIsmMetadataBuilder::format_metadata(&mut metadatas, 3),
            expected
        );
    }

    #[test]
    fn test_format_n_of_m_metadata_works_correctly() {
        // We're passing the metadatas of 4 ISMs (indexes 0, 1, 2, 4) out of 5
        let mut metadatas = vec![
            SubModuleMetadata::new(
                0,
                Vec::from_hex("290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563")
                    .unwrap(),
            ),
            SubModuleMetadata::new(
                1,
                Vec::from_hex("510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9")
                    .unwrap(),
            ),
            SubModuleMetadata::new(
                2,
                Vec::from_hex("356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336")
                    .unwrap(),
            ),
            SubModuleMetadata::new(
                4,
                Vec::from_hex("f2e59013a0a379837166b59f871b20a8a0d101d1c355ea85d35329360e69c000")
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
        let mut metadatas = vec![SubModuleMetadata::new(0, Vec::from_hex("").unwrap())];
        let expected = Vec::from_hex("0000000800000008").unwrap();
        assert_eq!(
            AggregationIsmMetadataBuilder::format_metadata(&mut metadatas, 1),
            expected
        );
    }

    #[test]
    fn test_n_cheapest_metas_works() {
        let metas_and_gas = vec![
            (
                SubModuleMetadata::new(3, vec![]),
                U256::from_dec_str("3").unwrap(),
            ),
            (
                SubModuleMetadata::new(2, vec![]),
                U256::from_dec_str("2").unwrap(),
            ),
            (
                SubModuleMetadata::new(1, vec![]),
                U256::from_dec_str("1").unwrap(),
            ),
        ];
        assert_eq!(
            AggregationIsmMetadataBuilder::n_cheapest_metas(metas_and_gas, 2),
            vec![
                SubModuleMetadata::new(1, vec![]),
                SubModuleMetadata::new(2, vec![])
            ]
        )
    }
}
