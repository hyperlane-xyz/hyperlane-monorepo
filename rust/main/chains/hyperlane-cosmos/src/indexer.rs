use std::fmt::Debug;
use std::ops::RangeInclusive;
use std::str::FromStr;

use cometbft::abci::{Event, EventAttribute};
use cometbft::hash::Algorithm;
use cometbft::Hash;
use cometbft_rpc::endpoint::tx;
use cometbft_rpc::endpoint::{
    block::Response as BlockResponse, block_results::Response as BlockResultsResponse,
};
use futures::future;
use tonic::async_trait;
use tracing::{debug, warn};

use hyperlane_core::{
    rpc_clients::BlockNumberGetter, ChainCommunicationError, ChainResult, Indexed, Indexer,
    LogMeta, H256, H512, U256,
};

use crate::utils::CONTRACT_ADDRESS_ATTRIBUTE_KEY;
use crate::{CosmosAddress, RpcProvider};

fn belongs_to_indexer(event: &Event, address: &H256) -> ChainResult<bool> {
    if !event.kind.as_str().starts_with("wasm-") {
        return Ok(true);
    }

    for attribute in &event.attributes {
        let key = attribute
            .key_str()
            .map_err(ChainCommunicationError::from_other)?;
        if key == CONTRACT_ADDRESS_ATTRIBUTE_KEY {
            let value = attribute
                .value_str()
                .map_err(ChainCommunicationError::from_other)?;
            return Ok(CosmosAddress::from_str(value)?.digest() == *address);
        }
    }

    Err(ChainCommunicationError::from_other_str(
        "missing contract_address",
    ))
}

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
        if tx_hash.is_zero() {
            return Ok(vec![]);
        }
        let tx_response = self.provider().get_tx(&tx_hash).await?;
        let block_height = tx_response.height.value() as u32;
        let block = self.provider().get_block(block_height).await?;
        let hash = H256::from_slice(block.block_id.hash.as_bytes());

        let result: Vec<_> = self
            .handle_tx(tx_response, hash)?
            .into_iter()
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
            .map(|result| result.map_err(ChainCommunicationError::from_other))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
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
        self.handle_block(block, block_results)
    }

    /// Iterate through all txs, filter out failed txs, find target events
    /// in successful txs, and parse them. Also iterates through all events in the block and tries to parse them.
    fn handle_block(
        &self,
        block: BlockResponse,
        block_results: BlockResultsResponse,
    ) -> ChainResult<Vec<(T, LogMeta)>> {
        let tx_results = block_results.txs_results.unwrap_or_default();
        // Cosmos can also emit events in the block itself, those events do not originate from a tx, but rather from the block
        let mut block_events = block_results.finalize_block_events;

        if let Some(begin_events) = block_results.begin_block_events {
            block_events.extend(begin_events);
        }

        if let Some(end_events) = block_results.end_block_events {
            block_events.extend(end_events);
        }

        let block_hash = H256::from_slice(block.block_id.hash.as_bytes());

        let tx_hashes = block
            .block
            .data
            .iter()
            .map(|tx| {
                let digest = hex::decode(sha256::digest(tx.as_slice()))?;
                Hash::from_bytes(Algorithm::Sha256, &digest)
                    .map_err(ChainCommunicationError::from_other)
            })
            .collect::<ChainResult<Vec<_>>>()?;
        if tx_results.len() != tx_hashes.len() {
            return Err(ChainCommunicationError::CustomError(format!(
                "Block transaction/result count mismatch: {} transactions, {} results",
                tx_hashes.len(),
                tx_results.len()
            )));
        }

        let mut logs = Vec::new();
        for (idx, (tx, tx_hash)) in tx_results.into_iter().zip(tx_hashes).enumerate() {
            if tx.code.is_err() {
                debug!(?tx_hash, "Not indexing failed transaction");
                continue;
            }
            let tx_response = tx::Response {
                hash: tx_hash,
                height: block_results.height,
                index: idx as u32,
                tx_result: tx,
                tx: vec![],
                proof: None,
            };
            logs.extend(self.handle_tx(tx_response, block_hash)?);
        }
        logs.extend(self.handle_block_events(
            block_events,
            block_hash,
            block.block.header.height.into(),
        )?);
        Ok(logs)
    }

    /// Iter through all events in the block, looking for any target events
    fn handle_block_events(
        &self,
        events: Vec<Event>,
        block_hash: H256,
        block_height: u64,
    ) -> ChainResult<Vec<(T, LogMeta)>> {
        let mut logs = Vec::new();
        for (log_idx, event) in events.into_iter().enumerate() {
            if event.kind.as_str() != Self::target_type() {
                continue;
            }
            if !belongs_to_indexer(&event, self.address())? {
                continue;
            }
            let parsed_event = self.parse(&event.attributes)?;
            logs.push((
                parsed_event.event,
                LogMeta {
                    address: parsed_event.contract_address,
                    block_number: block_height,
                    block_hash,
                    transaction_id: H512::zero(),
                    transaction_index: 0,
                    log_index: U256::from(log_idx),
                },
            ));
        }
        Ok(logs)
    }

    /// Iter through all events in the tx, looking for any target events
    /// made by the contract we are indexing.
    fn handle_tx(&self, tx: tx::Response, block_hash: H256) -> ChainResult<Vec<(T, LogMeta)>> {
        let tx_events = tx.tx_result.events;
        let tx_hash = tx.hash;
        let tx_index = tx.index;
        let block_height = tx.height;

        let mut logs = Vec::new();
        for (log_idx, event) in tx_events.into_iter().enumerate() {
            if event.kind.as_str() != Self::target_type() {
                continue;
            }
            if !belongs_to_indexer(&event, self.address())? {
                continue;
            }
            let parsed_event = self.parse(&event.attributes)?;
            logs.push((
                parsed_event.event,
                LogMeta {
                    address: parsed_event.contract_address,
                    block_number: block_height.value(),
                    block_hash,
                    transaction_id: H256::from_slice(tx_hash.as_bytes()).into(),
                    transaction_index: tx_index.into(),
                    log_index: U256::from(log_idx),
                },
            ));
        }
        Ok(logs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosmwasm_events_are_filtered_by_emitter_before_parsing() -> ChainResult<()> {
        let configured = H256::repeat_byte(1);
        let foreign = H256::repeat_byte(2);
        let foreign_address = CosmosAddress::from_h256(foreign, "neutron", 32)?.address();
        let configured_address = CosmosAddress::from_h256(configured, "neutron", 32)?.address();

        let foreign_event = Event::new(
            "wasm-mailbox_dispatch",
            [(CONTRACT_ADDRESS_ATTRIBUTE_KEY, foreign_address)],
        );
        assert!(!belongs_to_indexer(&foreign_event, &configured)?);

        let configured_event = Event::new(
            "wasm-mailbox_dispatch",
            [(CONTRACT_ADDRESS_ATTRIBUTE_KEY, configured_address)],
        );
        assert!(belongs_to_indexer(&configured_event, &configured)?);
        Ok(())
    }
}
