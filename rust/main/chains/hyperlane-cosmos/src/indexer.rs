use std::fmt::Debug;
use std::ops::RangeInclusive;

use futures::future;
use tendermint::abci::EventAttribute;
use tendermint::hash::Algorithm;
use tendermint::Hash;
use tendermint_rpc::endpoint::tx;
use tendermint_rpc::endpoint::{
    block::Response as BlockResponse, block_results::Response as BlockResultsResponse,
};
use tonic::async_trait;
use tracing::{debug, trace, warn};

use hyperlane_core::{
    rpc_clients::BlockNumberGetter, ChainResult, Indexed, Indexer, LogMeta, H256, H512, U256,
};

use crate::RpcProvider;

#[derive(Debug, Eq, PartialEq)]
/// An event parsed from the RPC response.
pub struct ParsedEvent<T: PartialEq> {
    contract_address: H256,
    event: T,
}

impl<T: PartialEq> ParsedEvent<T> {
    /// Create a new ParsedEvent.
    pub fn new(contract_address: H256, event: T) -> Self {
        Self {
            contract_address,
            event,
        }
    }
}

#[async_trait]
/// Event indexer that parses and filters events based on the target type & parse function.
pub trait CosmosEventIndexer<T: PartialEq + Send + Sync + 'static>: Indexer<T>
where
    Self: Clone + Send + Sync + 'static,
    Indexed<T>: From<T>,
{
    /// Target event to index
    fn target_type() -> String;

    /// Cosmos provider
    fn provider(&self) -> &RpcProvider;

    /// parses the event attributes to the target type
    fn parse(&self, attributes: &[EventAttribute]) -> ChainResult<ParsedEvent<T>>;

    /// address for the given module that will be indexed
    fn address(&self) -> &H256;

    /// Current block height
    ///
    /// used by the indexer struct
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let result = self.provider().get_block_number().await?;
        Ok(result as u32)
    }

    /// Fetch list of logs between blocks `from` and `to`, inclusive.
    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        let tx_response = self.provider().get_tx(&tx_hash).await?;
        let block_height = tx_response.height.value() as u32;
        let block = self.provider().get_block(block_height).await?;
        let hash = H256::from_slice(block.block_id.hash.as_bytes());

        let result: Vec<_> = self
            .handle_tx(tx_response, hash)
            // only return logs for the given address
            .filter(|(_, log)| log.address == *self.address())
            .map(|(value, logs)| (value.into(), logs))
            .collect();
        Ok(result)
    }

    /// Fetch list of logs emitted in a transaction with the given hash.
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        let futures: Vec<_> = range
            .map(|block_height| {
                let clone = self.clone();
                tokio::spawn(async move {
                    let logs = Self::get_logs_in_block(&clone, block_height).await;
                    (logs, block_height)
                })
            })
            .collect();

        let result = future::join_all(futures)
            .await
            .into_iter()
            .flatten()
            .map(|(logs, block_number)| {
                if let Err(err) = &logs {
                    warn!(?err, ?block_number, "Failed to fetch logs for block");
                }
                logs
            })
            // Propagate errors from any of the queries. This will cause the entire range to be retried,
            // including successful ones, but we don't have a way to handle partial failures in a range for now.
            // This is also why cosmos indexing should be run with small chunks (currently set to 5).
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .filter(|(_, log)| log.address == *self.address())
            .map(|(log, meta)| (log.into(), meta))
            .collect();
        Ok(result)
    }

    /// Fetches all of the block txs and parses them
    async fn get_logs_in_block(&self, block_height: u32) -> ChainResult<Vec<(T, LogMeta)>> {
        let block = self.provider().get_block(block_height).await?;
        let block_results = self.provider().get_block_results(block_height).await?;
        let result = self.handle_txs(block, block_results);
        Ok(result)
    }

    /// Iterate through all txs, filter out failed txs, find target events
    /// in successful txs, and parse them.
    fn handle_txs(
        &self,
        block: BlockResponse,
        block_results: BlockResultsResponse,
    ) -> Vec<(T, LogMeta)> {
        let Some(tx_results) = block_results.txs_results else {
            return vec![];
        };

        let tx_hashes: Vec<Hash> = block
            .clone()
            .block
            .data
            .into_iter()
            .filter_map(|tx| hex::decode(sha256::digest(tx.as_slice())).ok())
            .filter_map(|hash| Hash::from_bytes(Algorithm::Sha256, hash.as_slice()).ok())
            .collect();

        tx_results
            .into_iter()
            .enumerate()
            .filter_map(move |(idx, tx)| {
                let Some(tx_hash) = tx_hashes.get(idx) else {
                    debug!(?tx, "No tx hash found for tx");
                    return None;
                };
                if tx.code.is_err() {
                    debug!(?tx_hash, "Not indexing failed transaction");
                    return None;
                }

                // We construct a simplified structure `tx::Response` here so that we can
                // reuse `handle_tx` method below.
                let tx_response = tx::Response {
                    hash: *tx_hash,
                    height: block_results.height,
                    index: idx as u32,
                    tx_result: tx,
                    tx: vec![],
                    proof: None,
                };

                let block_hash = H256::from_slice(block.block_id.hash.as_bytes());

                Some(self.handle_tx(tx_response, block_hash))
            })
            .flatten()
            .collect()
    }

    /// Iter through all events in the tx, looking for any target events
    /// made by the contract we are indexing.
    fn handle_tx(&self, tx: tx::Response, block_hash: H256) -> impl Iterator<Item = (T, LogMeta)> {
        let tx_events = tx.tx_result.events;
        let tx_hash = tx.hash;
        let tx_index = tx.index;
        let block_height = tx.height;

        tx_events.into_iter().enumerate().filter_map(move |(log_idx, event)| {

            if event.kind.as_str() != Self::target_type() {
                return None;
            }

            self.parse(&event.attributes)
                .map_err(|err| {
                    trace!(?err, tx_hash=?tx_hash, log_idx, ?event, "Failed to parse event attributes");
                })
                .ok()
                .map(|parsed_event| {
                    (parsed_event.event, LogMeta {
                        address: parsed_event.contract_address,
                        block_number: block_height.value(),
                        block_hash,
                        transaction_id: H256::from_slice(tx_hash.as_bytes()).into(),
                        transaction_index: tx_index as u64,
                        log_index: U256::from(log_idx),
                    })
                })
        })
    }
}
