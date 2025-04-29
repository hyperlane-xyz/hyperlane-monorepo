use std::{fmt::Debug, marker::PhantomData, ops::RangeInclusive};

use fuels::{
    core::codec::LogDecoder,
    tx::Receipt,
    types::{bech32::Bech32ContractId, ContractId},
};

use hyperlane_core::{ChainResult, ContractLocator, Indexed, LogMeta, H512, U256};

/// Fuel Indexer event
pub mod events;
use events::FuelIndexerEvent;

/// Custom GraphQL query for Fuel Indexer
mod query;
use query::{
    types::{BlocksQuery, Transaction as SchemaTransaction},
    FuelGraphQLClient,
};

use crate::{conversions::*, wallet::FuelWallets, ConnectionConf, FuelProvider};

/// A Fuel Indexer supporting a specific event type.
/// The generic `E` is the type of the event this indexer will be filtering and parsing.
///
/// # Fields
///
/// * `fuel_provider` - An instance of `FuelProvider` responsible for interacting with the Fuel blockchain.
/// * `contract_address` - The Bech32 encoded contract ID that this indexer is associated with.
/// * `log_decoder` - An instance of `LogDecoder` used to decode logs emitted by the contract.
/// * `graphql_client` - An instance of `FuelGraphQLClient` used to query the Fuel blockchain.
/// * `_phantom` - A marker to indicate the use of a generic type `E`.
pub struct FuelIndexer<E>
where
    E: FuelIndexerEvent,
{
    fuel_provider: FuelProvider,
    contract_address: Bech32ContractId,
    log_decoder: LogDecoder,
    graphql_client: FuelGraphQLClient,
    _phantom: PhantomData<E>,
}

// Since Fuel does not support point in time queries, we add a buffer to the query range
// This allows the block and tip queries to be inconsistent to a certain degree.
const INCONSISTENCY_BLOCK_BUFFER: u32 = 10;

impl<E> Debug for FuelIndexer<E>
where
    E: FuelIndexerEvent,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FuelIndexer")
            .field("fuel_provider", &self.fuel_provider)
            .field("contract_address", &self.contract_address)
            .field("log_decoder", &self.log_decoder)
            .finish()
    }
}

impl<E> FuelIndexer<E>
where
    E: FuelIndexerEvent,
{
    /// Create a new fuel indexer
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        wallet: FuelWallets,
    ) -> Self {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;
        let contract_address = Bech32ContractId::from_h256(&locator.address);
        let graphql_client = FuelGraphQLClient::new(&conf.url);
        let decoder = E::log_decoder(contract_address.clone(), wallet);

        Self {
            fuel_provider,
            contract_address,
            log_decoder: decoder,
            graphql_client,
            _phantom: PhantomData,
        }
    }

    /// Get the custom Fuel Provider
    pub fn provider(&self) -> &FuelProvider {
        &self.fuel_provider
    }

    /// Index logs which were specified during the construction of the indexer.
    /// The `E` type is the event which is being indexed.
    /// The `T` type is the data which we are transforming the event data into.
    pub async fn index_logs_in_range<T>(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>>
    where
        T: Into<Indexed<T>> + PartialEq + Send + Sync + Debug + 'static + From<E>,
    {
        let (start, end) = range.into_inner();
        let block_data = self
            .graphql_client
            .query_blocks_in_range(&RangeInclusive::new(
                start,
                end + INCONSISTENCY_BLOCK_BUFFER,
            ))
            .await?;

        Ok(self.filter_and_parse_transactions::<T>(block_data))
    }

    fn filter_and_parse_transactions<T>(&self, data: BlocksQuery) -> Vec<(Indexed<T>, LogMeta)>
    where
        T: Into<Indexed<T>> + PartialEq + Send + Sync + Debug + 'static + From<E>,
    {
        data.blocks
            .nodes
            .into_iter()
            .flat_map(|block| {
                let block_number = block.header.height.0 as u64;
                let block_hash = block.id.0 .0.into_h256();

                block
                    .transactions
                    .into_iter()
                    .enumerate()
                    .filter_map(move |(index, tx)| {
                        if !tx.is_valid() || !self.is_transaction_from_contract(&tx) {
                            return None;
                        }

                        let receipts = tx.extract_receipts().unwrap_or_default();
                        Some(
                            self.extract_logs::<T>(receipts.clone())
                                .into_iter()
                                .map(|(relevant_event, log_index)| {
                                    let log_meta = LogMeta {
                                        address: self.contract_address.clone().into_h256(),
                                        block_number,
                                        block_hash,
                                        transaction_id: H512::from(tx.id.0 .0.into_h256()),
                                        transaction_index: index as u64,
                                        log_index: U256::from(log_index),
                                    };

                                    (relevant_event.into(), log_meta)
                                })
                                .collect::<Vec<_>>(),
                        )
                    })
            })
            .flatten()
            .collect::<Vec<_>>()
    }

    fn decode_log(&self, receipt: Receipt) -> Option<E> {
        let decoder = &self.log_decoder;
        match decoder.decode_logs_with_type::<E>(&[receipt]) {
            Ok(decoded_logs) if !decoded_logs.is_empty() => Some(decoded_logs[0].clone()),
            _ => None,
        }
    }

    fn extract_logs<T>(&self, receipts: Vec<Receipt>) -> Vec<(T, usize)>
    where
        T: Into<Indexed<T>> + PartialEq + Send + Sync + Debug + 'static + From<E>,
    {
        receipts
            .into_iter()
            .enumerate()
            .filter(|(_, receipt)| {
                receipt
                    .id()
                    .is_some_and(|id| *id == ContractId::from(self.contract_address.clone()))
            })
            .filter_map(|(index, receipt)| {
                self.decode_log(receipt)
                    .map(|decoded_log| (decoded_log.transform::<T>(), index))
            })
            .collect()
    }

    fn is_transaction_from_contract(&self, tx: &SchemaTransaction) -> bool {
        if let Some(inputs) = &tx.input_contracts {
            return inputs
                .iter()
                .any(|input| input.0 .0 == ContractId::from(&self.contract_address));
        }
        false
    }
}
