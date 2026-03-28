use {
    crate::SearchTxOutcomeExt,
    hyperlane_core::Delivery,
    {
        super::DangoMailbox,
        crate::{DangoConvertor, SearchLog, TryDangoConvertor},
        async_trait::async_trait,
        dango_hyperlane_types::mailbox,
        grug::{Inner, SearchTxClient},
        hyperlane_core::{
            ChainResult, HyperlaneContract, HyperlaneMessage, Indexed, Indexer, LogMeta,
            SequenceAwareIndexer, H256, H512,
        },
        std::ops::RangeInclusive,
    },
};

// --------------------------------- dispatch ----------------------------------

#[async_trait]
impl Indexer<HyperlaneMessage> for DangoMailbox {
    /// Fetch list of logs between blocks `from` and `to`, inclusive.
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        Ok(self
            .provider
            .fetch_logs(range)
            .await?
            .search_contract_log::<mailbox::Dispatch, _>(
                self.address().try_convert()?,
                search_fn_dispatch,
            )?)
    }

    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(self.provider.latest_block().await? as u32)
    }

    /// Fetch list of logs emitted in a transaction with the given hash.
    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        Ok(self
            .provider
            .search_tx(tx_hash.try_convert()?)
            .await?
            .with_block_hash(&self.provider)
            .await?
            .search_contract_log(self.address().try_convert()?, search_fn_dispatch)?)
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for DangoMailbox {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let (nonce, last_height) = self
            .provider
            .query_wasm_smart_with_height(
                self.address().try_convert()?,
                mailbox::QueryNonceRequest {},
            )
            .await?;
        Ok((Some(nonce), last_height as u32))
    }
}

fn search_fn_dispatch(event: mailbox::Dispatch) -> Indexed<HyperlaneMessage> {
    HyperlaneMessage {
        version: event.0.version,
        nonce: event.0.nonce,
        origin: event.0.origin_domain,
        sender: event.0.sender.convert(),
        destination: event.0.destination_domain,
        recipient: event.0.recipient.convert(),
        body: event.0.body.into_inner(),
    }
    .into()
}

// --------------------------------- delivery ----------------------------------

#[async_trait]
impl Indexer<Delivery> for DangoMailbox {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        Ok(self
            .provider
            .fetch_logs(range)
            .await?
            .search_contract_log::<mailbox::ProcessId, _>(
                self.address().try_convert()?,
                search_fn_delivery,
            )?)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(self.provider.latest_block().await? as u32)
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        Ok(self
            .provider
            .search_tx(tx_hash.try_convert()?)
            .await?
            .with_block_hash(&self.provider)
            .await?
            .search_contract_log(self.address().try_convert()?, search_fn_delivery)?)
    }
}

#[async_trait]
impl SequenceAwareIndexer<Delivery> for DangoMailbox {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // No sequence for message deliveries.
        Ok((None, self.provider.latest_block().await? as u32))
    }
}

fn search_fn_delivery(event: mailbox::ProcessId) -> Indexed<Delivery> {
    DangoConvertor::<Delivery>::convert(event.message_id).into()
}
