use async_trait::async_trait;
use futures_util::future::{join_all, try_join};
use std::ops::Deref;

use derive_new::new;
use eyre::Context;
use tracing::{info, instrument};

use hyperlane_core::{HyperlaneMessage, H256};

use super::{BaseMetadataBuilder, MetadataBuilder};

/// Bytes used to store one member of the (start, end) range tuple
/// Copied from `AggregationIsmMetadata.sol`
const METADATA_RANGE_SIZE: usize = 4;

#[derive(Clone, Debug, new)]
pub struct AggregationIsmMetadataBuilder {
    base: BaseMetadataBuilder,
}

impl AggregationIsmMetadataBuilder {
    fn format_metadata(metadatas: &mut Vec<Vec<u8>>) -> Vec<u8> {
        // See test solidity implementation of this fn at `AggregationIsm.t.sol:getMetadata(...)`
        fn encode_byte_index(i: usize) -> [u8; 4] {
            (i as u32).to_be_bytes()
        }
        let range_tuples_size = METADATA_RANGE_SIZE * 2 * metadatas.len();
        //  Format of metadata:
        //  [????:????] Metadata start/end uint32 ranges, packed as uint64
        //  [????:????] ISM metadata, packed encoding
        // Initialize the range tuple part of the buffer, so the actual metadatas can
        // simply be appended to it
        let mut buffer = vec![0; range_tuples_size];
        for (index, metadata) in metadatas.into_iter().enumerate() {
            let range_start = buffer.len();
            // Append the ism metadata as-is, since it's already encoded
            buffer.append(metadata);
            let range_end = buffer.len();

            // The new tuple starts at the end of the previous ones.
            // See `AggregationIsmMetadata.sol:_metadataRange()` as well.
            let encoded_range_start = METADATA_RANGE_SIZE * 2 * index;
            // Overwrite the 0-initialized range tuple
            buffer.splice(
                encoded_range_start..(encoded_range_start + METADATA_RANGE_SIZE * 2),
                [encode_byte_index(range_start), encode_byte_index(range_end)].concat(),
            );
        }
        buffer
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
        .filter_map(|r| match r.ok() {
            Some((Some(meta), ism)) => Some((meta, ism)),
            _ => None,
        })
        .collect();

        // send view / dryrun txs to see which ism will succeed
        let mut metas_and_gas: Vec<_> =
            join_all(sub_isms.into_iter().map(|(meta, ism)| async move {
                let gas = ism.dry_run_verify(message, &meta).await;
                (meta, gas)
            }))
            .await
            .into_iter()
            .filter_map(|(meta, gast_result)| gast_result.ok().flatten().map(|gc| (meta, gc)))
            .collect();

        let metas_and_gas_count = metas_and_gas.len();
        if metas_and_gas_count < threshold {
            info!("Could not fetch metadata: Only found {metas_and_gas_count} of the {threshold} required ISM metadata pieces");
            return Ok(None);
        }
        metas_and_gas.sort_by(|(_, gas_1), (_, gas_2)| gas_1.partial_cmp(gas_2).unwrap());
        let mut cheapest_metas = metas_and_gas[..threshold]
            .to_vec()
            .into_iter()
            .map(|(meta, _)| meta)
            .collect();

        // then bundle the metadata into a single byte array
        Ok(Some(Self::format_metadata(&mut cheapest_metas)))
    }
}

#[cfg(test)]
mod test {
    use ethers::utils::hex::FromHex;

    use super::*;

    #[test]
    fn test_format_metadata_works_correctly() {
        let mut metadatas = vec![
            Vec::from_hex("290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563")
                .unwrap(),
            Vec::from_hex("510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9")
                .unwrap(),
            Vec::from_hex("356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336")
                .unwrap(),
            Vec::from_hex("b903bd7696740696b2b18bd1096a2873bb8ad0c2e7f25b00a0431014edb3f539")
                .unwrap(),
        ];
        let expected = Vec::from_hex("00000020000000400000004000000060000000600000008000000080000000a0290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336b903bd7696740696b2b18bd1096a2873bb8ad0c2e7f25b00a0431014edb3f539").unwrap();
        assert_eq!(
            AggregationIsmMetadataBuilder::format_metadata(&mut metadatas),
            expected
        );
    }

    #[test]
    fn test_format_empty_metadata_works_correctly() {
        let mut metadatas = vec![Vec::from_hex("").unwrap()];
        let expected = Vec::from_hex("0000000800000008").unwrap();
        assert_eq!(
            AggregationIsmMetadataBuilder::format_metadata(&mut metadatas),
            expected
        );
    }
}
