use async_trait::async_trait;
use futures_util::future::{join_all, try_join};
use std::ops::Deref;

use derive_new::new;
use eyre::Context;
use tracing::{info, instrument};

use hyperlane_core::{HyperlaneMessage, InterchainSecurityModule, H256, U256};

use super::{BaseMetadataBuilder, MetadataBuilder};

/// Bytes used to store one member of the (start, end) range tuple
/// Copied from `AggregationIsmMetadata.sol`
const METADATA_RANGE_SIZE: usize = 4;

#[derive(Clone, Debug, new)]
pub struct AggregationIsmMetadataBuilder {
    base: BaseMetadataBuilder,
}

impl AggregationIsmMetadataBuilder {
    // also need to pass a vec of the indexes corresponding to the chosen metas
    fn format_metadata(metadatas: &mut [(usize, Vec<u8>)], ism_count: usize) -> Vec<u8> {
        // See test solidity implementation of this fn at `AggregationIsm.t.sol:getMetadata(...)`
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
        for (index, metadata) in metadatas.iter_mut() {
            let range_start = buffer.len();
            // Append the ism metadata as-is, since it's already encoded
            buffer.append(metadata);
            let range_end = buffer.len();

            // The new tuple starts at the end of the previous ones.
            // See `AggregationIsmMetadata.sol:_metadataRange()` as well.
            let encoded_range_start = METADATA_RANGE_SIZE * 2 * (*index);
            // Overwrite the 0-initialized range tuple
            buffer.splice(
                encoded_range_start..(encoded_range_start + METADATA_RANGE_SIZE * 2),
                [encode_byte_index(range_start), encode_byte_index(range_end)].concat(),
            );
        }
        buffer
    }

    fn n_cheapest_metas(
        mut metas_and_gas: Vec<(usize, Vec<u8>, U256)>,
        n: usize,
    ) -> Vec<(usize, Vec<u8>)> {
        metas_and_gas.sort_by(|(_, _, gas_1), (_, _, gas_2)| gas_1.cmp(gas_2));
        let mut cheapest: Vec<_> = metas_and_gas[..n].into();
        cheapest.sort_by(|(index_1, _, _), (index_2, _, _)| index_1.cmp(index_2));
        cheapest
            .iter()
            .cloned()
            .map(|(index, meta, _)| (index, meta))
            .collect()
    }

    async fn cheapest_valid_metas(
        sub_isms: Vec<(usize, Vec<u8>, Box<dyn InterchainSecurityModule>)>,
        message: &HyperlaneMessage,
        threshold: usize,
    ) -> eyre::Result<Option<Vec<(usize, Vec<u8>)>>> {
        let metas_and_gas: Vec<_> =
            join_all(sub_isms.into_iter().map(|(index, meta, ism)| async move {
                let gas = ism.dry_run_verify(message, &meta).await;
                (index, meta, gas)
            }))
            .await
            .into_iter()
            .filter_map(|(index, meta, gast_result)| {
                gast_result.ok().flatten().map(|gc| (index, meta, gc))
            })
            .collect();

        let metas_and_gas_count = metas_and_gas.len();
        if metas_and_gas_count < threshold {
            info!("Could not fetch all metadata: Found {metas_and_gas_count} of the {threshold} required ISM metadata pieces");
            return Ok(None);
        }
        Ok(Some(Self::n_cheapest_metas(metas_and_gas, threshold)))
    }
}

impl Deref for AggregationIsmMetadataBuilder {
    type Target = BaseMetadataBuilder;

    fn deref(&self) -> &Self::Target {
        &self.base
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
        const CTX: &str = "When fetching RoutingIsm metadata";
        let ism = self.build_aggregation_ism(ism_address).await.context(CTX)?;
        let (modules, threshold) = ism.modules_and_threshold(message).await.context(CTX)?;
        let threshold = threshold as usize;

        let sub_isms: Vec<_> = join_all(modules.iter().map(|ism_address| {
            try_join(
                self.base.build(*ism_address, message),
                self.base.build_ism(*ism_address),
            )
        }))
        .await
        .into_iter()
        .enumerate()
        .filter_map(|(i, r)| match r {
            Ok((Some(meta), ism)) => Some((i, meta, ism)),
            _ => None,
        })
        .collect();

        Self::cheapest_valid_metas(sub_isms, message, threshold)
            .await
            .map(|maybe_proofs| {
                maybe_proofs.map(|mut proofs| Self::format_metadata(&mut proofs, modules.len()))
            })
    }
}

#[cfg(test)]
mod test {
    use ethers::utils::hex::FromHex;

    use super::*;

    #[test]
    fn test_format_n_of_n_metadata_works_correctly() {
        let mut metadatas = vec![
            (
                0,
                Vec::from_hex("290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563")
                    .unwrap(),
            ),
            (
                1,
                Vec::from_hex("510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9")
                    .unwrap(),
            ),
            (
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
        let mut metadatas = vec![
            (
                0,
                Vec::from_hex("290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563")
                    .unwrap(),
            ),
            (
                1,
                Vec::from_hex("510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9")
                    .unwrap(),
            ),
            (
                2,
                Vec::from_hex("356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336")
                    .unwrap(),
            ),
            (
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
        let mut metadatas = vec![(0, Vec::from_hex("").unwrap())];
        let expected = Vec::from_hex("0000000800000008").unwrap();
        assert_eq!(
            AggregationIsmMetadataBuilder::format_metadata(&mut metadatas, 1),
            expected
        );
    }

    #[test]
    fn test_n_cheapest_metas_works() {
        let metas_and_gas = vec![
            (3, vec![], U256::from_dec_str("3").unwrap()),
            (2, vec![], U256::from_dec_str("2").unwrap()),
            (1, vec![], U256::from_dec_str("1").unwrap()),
        ];
        assert_eq!(
            AggregationIsmMetadataBuilder::n_cheapest_metas(metas_and_gas, 2),
            vec![(1, vec![]), (2, vec![])]
        )
    }
}
