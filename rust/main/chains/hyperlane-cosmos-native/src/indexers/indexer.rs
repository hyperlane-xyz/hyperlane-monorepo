use crate::{error, CosmosNativeProvider};
use futures::future;
use hyperlane_core::rpc_clients::BlockNumberGetter;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, HyperlaneProvider, Indexed, LogMeta, H256, H512, U256,
};
use itertools::Itertools;
use std::fmt::Debug;
use std::ops::RangeInclusive;
use std::sync::Arc;
use tendermint::abci::{Event, EventAttribute};
use tendermint::hash::Algorithm;
use tendermint::Hash;
use tendermint_rpc::endpoint::block::Response as BlockResponse;
use tendermint_rpc::endpoint::block_results::{self, Response as BlockResultsResponse};
use tendermint_rpc::endpoint::tx;
use tokio::task::JoinHandle;
use tracing::{debug, error, event, trace, warn, Level};

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

    /// Get the inner event
    pub fn inner(self) -> T {
        self.event
    }
}
/// Event indexer
///
/// Indexes all events of a specified event type.
#[derive(Debug, Clone)]
pub struct EventIndexer {
    target_type: String,
    provider: Arc<CosmosNativeProvider>,
}

/// Parsing function
///
/// This function is used to parse the event attributes into a ParsedEvent.
pub type Parser<T> = for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>;

impl EventIndexer {
    /// Create a new EventIndexer.
    pub fn new(target_type: String, provider: Arc<CosmosNativeProvider>) -> EventIndexer {
        EventIndexer {
            target_type,
            provider,
        }
    }

    /// Current block height
    ///
    /// used by the indexer struct
    pub async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let result = self.provider.rpc().get_block_number().await?;
        Ok(result as u32)
    }

    pub(crate) async fn fetch_logs_by_tx_hash<T>(
        &self,
        tx_hash: H512,
        parser: Parser<T>,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>>
    where
        T: PartialEq + 'static,
        Indexed<T>: From<T>,
    {
        let tx_response = self.provider.rpc().get_tx(&tx_hash).await?;
        let block_height = tx_response.height;
        let block = self
            .provider
            .get_block_by_height(block_height.into())
            .await?;

        let result: Vec<_> = self
            .handle_tx(tx_response, block.hash, parser)
            .map(|(value, logs)| (value.into(), logs))
            .collect();
        Ok(result)
    }

    pub(crate) async fn fetch_logs_in_range<T>(
        &self,
        range: RangeInclusive<u32>,
        parser: Parser<T>,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>>
    where
        T: PartialEq + Debug + 'static + Send + Sync,
        Indexed<T>: From<T>,
    {
        let futures: Vec<_> = range
            .map(|block_height| {
                let clone = self.clone();
                tokio::spawn(async move {
                    let logs = Self::get_logs_in_block(&clone, block_height, parser).await;
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
            .map(|(log, meta)| (log.into(), meta))
            .collect();
        Ok(result)
    }

    async fn get_logs_in_block<T>(
        &self,
        block_height: u32,
        parser: Parser<T>,
    ) -> ChainResult<Vec<(T, LogMeta)>>
    where
        T: PartialEq + Debug + 'static,
    {
        let block = self.provider.rpc().get_block(block_height).await?;
        let block_results = self.provider.rpc().get_block_results(block_height).await?;
        let result = self.handle_txs(block, block_results, parser);
        Ok(result)
    }

    // Iterate through all txs, filter out failed txs, find target events
    // in successful txs, and parse them.
    fn handle_txs<T>(
        &self,
        block: BlockResponse,
        block_results: BlockResultsResponse,
        parser: Parser<T>,
    ) -> Vec<(T, LogMeta)>
    where
        T: PartialEq + Debug + 'static,
    {
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

                Some(self.handle_tx(tx_response, block_hash, parser))
            })
            .flatten()
            .collect()
    }

    // Iter through all events in the tx, looking for any target events
    // made by the contract we are indexing.
    fn handle_tx<T>(
        &self,
        tx: tx::Response,
        block_hash: H256,
        parser: Parser<T>,
    ) -> impl Iterator<Item = (T, LogMeta)> + '_
    where
        T: PartialEq + 'static,
    {
        let tx_events = tx.tx_result.events;
        let tx_hash = tx.hash;
        let tx_index = tx.index;
        let block_height = tx.height;

        tx_events.into_iter().enumerate().filter_map(move |(log_idx, event)| {

            if event.kind.as_str() != self.target_type {
                return None;
            }

            parser(&event.attributes)
                .map_err(|err| {
                    trace!(?err, tx_hash=?tx_hash, log_idx, ?event, "Failed to parse event attributes");
                })
                .ok()
                .and_then(|parsed_event| {
                    Some((parsed_event.event, LogMeta {
                        address: parsed_event.contract_address,
                        block_number: block_height.value(),
                        block_hash,
                        transaction_id: H256::from_slice(tx_hash.as_bytes()).into(),
                        transaction_index: tx_index as u64,
                        log_index: U256::from(log_idx),
                    }))
                })
        })
    }
}
