use {
    super::DangoIGP,
    crate::IntoDangoError,
    async_trait::async_trait,
    grug::BlockClient,
    hyperlane_core::{ChainResult, Indexed, Indexer, InterchainGasPayment, LogMeta, H512},
    std::ops::RangeInclusive,
};

#[async_trait]
impl Indexer<InterchainGasPayment> for DangoIGP {
    async fn fetch_logs_in_range(
        &self,
        _range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        Ok(vec![])
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(self
            .provider
            .query_block(None)
            .await
            .into_dango_error()?
            .info
            .height as u32)
    }

    /// Fetch list of logs emitted in a transaction with the given hash.
    async fn fetch_logs_by_tx_hash(
        &self,
        _tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        Ok(vec![])
    }
}
