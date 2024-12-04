use std::{fmt::Debug, marker::PhantomData, ops::RangeInclusive};

use fuels::{
    accounts::wallet::WalletUnlocked,
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

use crate::{conversions::*, ConnectionConf, FuelProvider};

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
        wallet: WalletUnlocked,
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
        let block_data = self.graphql_client.query_blocks_in_range(&range).await?;

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
                        if !tx.is_valid()
                            || !self.is_transaction_from_contract(&tx)
                            || !self.has_event(&tx)
                        {
                            return None;
                        }

                        let receipts = tx.extract_receipts().unwrap_or_default();

                        let (relevant_event, log_index) =
                            self.extract_log::<T>(receipts.clone())?;

                        let log_meta = LogMeta {
                            address: self.contract_address.clone().into_h256(),
                            block_number,
                            block_hash,
                            transaction_id: H512::from(tx.id.0 .0.into_h256()),
                            transaction_index: index as u64,
                            log_index: U256::from(log_index),
                        };

                        Some((relevant_event.into(), log_meta))
                    })
            })
            .collect::<Vec<_>>()
    }

    fn has_event(&self, tx: &SchemaTransaction) -> bool {
        let decoder = &self.log_decoder;
        let receipts = tx.extract_receipts().unwrap_or_default();
        if let Ok(decoded_logs) = decoder.decode_logs_with_type::<E>(&receipts) {
            return !decoded_logs.is_empty();
        }
        false
    }

    fn extract_log<T>(&self, receipts: Vec<Receipt>) -> Option<(T, usize)>
    where
        T: Into<Indexed<T>> + PartialEq + Send + Sync + Debug + 'static + From<E>,
    {
        let decoder = &self.log_decoder;
        for (index, receipt) in receipts.into_iter().enumerate() {
            if let Ok(decoded_logs) = decoder.decode_logs_with_type::<E>(&[receipt]) {
                if !decoded_logs.is_empty() && decoded_logs.len() == 1 {
                    return Some((decoded_logs[0].clone().transform::<T>(), index));
                }
            }
        }
        None
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
