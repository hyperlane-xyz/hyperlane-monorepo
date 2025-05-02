use std::fmt::Debug;
use std::ops::RangeInclusive;

use async_trait::async_trait;
use futures::stream::{self, FuturesOrdered, TryStreamExt};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, Indexed, Indexer, LogMeta, SequenceAwareIndexer, H256,
    H512,
};

use crate::rest_client::{self, Tx, TxEvent};

// SovIndexer is a trait that contains default implementations for indexing
// various different event types on the Sovereign chain to reduce code duplication in
// e.g. SovereignMailboxIndexer, SovereignInterchainGasPaymasterIndexer, etc.
#[async_trait]
pub trait SovIndexer<T>: Indexer<T> + SequenceAwareIndexer<T>
where
    T: Into<Indexed<T>> + Debug + Clone + Send,
{
    fn client(&self) -> &rest_client::SovereignRestClient;
    fn decode_event(&self, event: &TxEvent) -> ChainResult<T>;
    async fn latest_sequence(&self, at_slot: Option<u64>) -> ChainResult<Option<u32>>;
    const EVENT_KEY: &'static str;

    // Default implementation of Indexer<T>
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        let logs = range
            .map(|slot_num| async move {
                let slot = self.client().get_specified_slot(slot_num.into()).await?;
                let slot_hash = parse_hex_to_h256(&slot.hash, "invalid block hash")?;
                ChainResult::Ok(stream::iter(
                    slot.batches
                        .into_iter()
                        .flat_map(|batch| batch.txs)
                        .map(move |tx| self.process_tx(&tx, slot_hash)),
                ))
            })
            .collect::<FuturesOrdered<_>>()
            .try_flatten()
            .try_collect::<Vec<_>>()
            .await?
            .concat();

        Ok(logs)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        // todo: should be finalized, but we need to query state at height first
        let latest_slot = self.client().get_latest_slot().await?;
        Ok(latest_slot.try_into().expect("Slot number overflowed u32"))
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        let tx_hash: H256 = tx_hash.into();
        let tx_hash = format!("0x{tx_hash:x}");
        let tx = self.client().get_tx_by_hash(tx_hash).await?;
        let batch = self.client().get_batch(tx.batch_number).await?;
        let batch_hash = parse_hex_to_h256(&batch.hash, "invalid block hash")?;
        self.process_tx(&tx, batch_hash)
    }

    // Default implementation of SequenceAwareIndexer<T>
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let finalized_slot = self.client().get_finalized_slot().await?;
        let sequence = self.latest_sequence(Some(finalized_slot)).await?;

        Ok((
            sequence,
            finalized_slot
                .try_into()
                .map_err(|e| ChainCommunicationError::CustomError(format!("{e:?}")))?,
        ))
    }

    // Helper function to process a single transaction
    fn process_tx(&self, tx: &Tx, slot_hash: H256) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        tx.events
            .iter()
            .filter(|ev| ev.key == Self::EVENT_KEY)
            .map(|ev| self.process_event(tx, ev, tx.batch_number, slot_hash))
            .collect()
    }

    // Helper function to process a single event
    fn process_event(
        &self,
        tx: &Tx,
        event: &TxEvent,
        slot_num: u64,
        slot_hash: H256,
    ) -> ChainResult<(Indexed<T>, LogMeta)> {
        let tx_hash = parse_hex_to_h256(&tx.hash, "invalid tx hash")?;
        let decoded_event = self.decode_event(event)?;

        let meta = LogMeta {
            address: slot_hash, // TODO: This should be the address of the contract that emitted the event, not the batch hash
            block_number: slot_num,
            block_hash: slot_hash,
            transaction_id: tx_hash.into(), // 0-prefix the tx hash up to 64 bytes for compatibility with the indexer
            transaction_index: tx.number, // TODO: This doesn't match the ethers behavior. tx number in sovereign is global, while this is block-local.
            log_index: event.number.into(), // TODO: This doesn't match the ethers behavior. event number in sovereign is global, while this is block-local.
        };

        Ok((decoded_event.into(), meta))
    }
}

fn parse_hex_to_h256(hex: &str, error_msg: &str) -> Result<H256, ChainCommunicationError> {
    hex_to_h256(hex).ok_or(ChainCommunicationError::ParseError {
        msg: error_msg.to_string(),
    })
}

fn hex_to_h256(hex: &str) -> Option<H256> {
    hex.strip_prefix("0x")
        .and_then(|h| hex::decode(h).ok())
        .and_then(|bytes| bytes.try_into().ok())
        .map(|array: [u8; 32]| array.into())
}
