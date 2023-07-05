use async_trait::async_trait;
use derive_more::Deref;
use futures_util::future::join_all;

use derive_new::new;
use eyre::Context;
use tracing::{info, instrument};

use hyperlane_core::{HyperlaneMessage, InterchainSecurityModule, H256, U256};

use super::{BaseMetadataBuilder, MetadataBuilder};

/// Bytes used to store one member of the (start, end) range tuple
/// Copied from `AggregationIsmMetadata.sol`
const METADATA_RANGE_SIZE: usize = 4;

#[derive(Clone, Debug, new, Deref)]
pub struct AggregationIsmMetadataBuilder {
    base: BaseMetadataBuilder,
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
    ) -> Option<Vec<SubModuleMetadata>> {
        let gas_cost_results: Vec<_> = join_all(
            sub_modules
                .iter()
                .map(|module| module.ism.dry_run_verify(message, &(module.meta.metadata))),
        )
        .await;

        // Filter out the ISMs without a gas cost estimate
        let metas_and_gas: Vec<_> = sub_modules
            .into_iter()
            .zip(gas_cost_results.into_iter())
            .filter_map(|(module, gas_cost)| gas_cost.ok().flatten().map(|gc| (module.meta, gc)))
            .collect();

        let metas_and_gas_count = metas_and_gas.len();
        if metas_and_gas_count < threshold {
            info!("Could not fetch all metadata: Found {metas_and_gas_count} of the {threshold} required ISM metadata pieces");
            return None;
        }
        Some(Self::n_cheapest_metas(metas_and_gas, threshold))
    }
}

#[async_trait]
impl MetadataBuilder for AggregationIsmMetadataBuilder {
    #[instrument(err, skip(self))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> eyre::Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching AggregationIsm metadata";
        let ism = self.build_aggregation_ism(ism_address).await.context(CTX)?;
        let (ism_addresses, threshold) = ism.modules_and_threshold(message).await.context(CTX)?;
        let threshold = threshold as usize;

        let metas = join_all(
            ism_addresses
                .iter()
                .map(|ism_address| self.base.build(*ism_address, message)),
        )
        .await;

        let sub_modules = join_all(
            ism_addresses
                .iter()
                .map(|ism_address| self.base.build_ism(*ism_address)),
        )
        .await;

        let filtered_sub_module_metas = metas
            .into_iter()
            .enumerate()
            .zip(sub_modules.into_iter())
            .filter_map(|((index, meta_result), sub_module_result)| {
                match (meta_result, sub_module_result) {
                    (Ok(Some(meta)), Ok(ism)) => Some(IsmAndMetadata::new(ism, index, meta)),
                    _ => None,
                }
            })
            .collect();

        let maybe_aggregation_metadata =
            Self::cheapest_valid_metas(filtered_sub_module_metas, message, threshold)
                .await
                .map(|mut metas| Self::format_metadata(&mut metas, ism_addresses.len()));
        Ok(maybe_aggregation_metadata)
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
