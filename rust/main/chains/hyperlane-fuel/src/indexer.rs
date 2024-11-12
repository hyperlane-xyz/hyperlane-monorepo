use crate::{conversions::*, indexer_events::FuelIndexerEvent, ConnectionConf, FuelProvider};
use fuels::{
    accounts::wallet::WalletUnlocked,
    client::{PageDirection, PaginationRequest},
    core::codec::LogDecoder,
    types::{
        bech32::Bech32ContractId,
        transaction::{Transaction, TransactionType},
        transaction_response::TransactionResponse,
        tx_status::TxStatus,
        BlockHeight, Bytes32, ContractId,
    },
};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Indexed, LogMeta, H512, U256,
};
use std::{
    collections::HashMap,
    fmt::Debug,
    marker::PhantomData,
    ops::{Deref, RangeInclusive},
};

// TODO, clippy issues

/// A Fuel Indexer supporting a specific event type.
/// The generic `E` is the type of the event this indexer will be filtering and parsing.
///
/// # Fields
///
/// * `fuel_provider` - An instance of `FuelProvider` responsible for interacting with the Fuel blockchain.
/// * `contract_address` - The Bech32 encoded contract ID that this indexer is associated with.
/// * `log_decoder` - An instance of `LogDecoder` used to decode logs emitted by the contract.
/// * `_phantom` - A marker to indicate the use of a generic type `E`.
pub struct FuelIndexer<E>
where
    E: FuelIndexerEvent,
{
    fuel_provider: FuelProvider,
    contract_address: Bech32ContractId,
    log_decoder: LogDecoder,
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

        let decoder = E::log_decoder(contract_address.clone(), wallet);
        let fn_decoder = decoder.clone();

        Self {
            fuel_provider,
            contract_address,
            log_decoder: decoder,
            _phantom: PhantomData,
        }
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
        let (block_cursor, transaction_cursor) = self.get_sync_cursors(&range).await?;

        let (transaction_amount, transaction_map) = self
            .get_block_data(range.clone(), block_cursor.clone())
            .await?;

        // By now we are sure that we either have no transactions or matching transactions
        let filtered_transactions = self
            .get_transaction_data(&transaction_map, transaction_cursor.clone())
            .await?;

        // Transaction data with event data transformed into the relevant indexed data
        let complete_indexer_log_data = self.append_with_event_data::<T>(filtered_transactions);

        let indexed_logs: Vec<(Indexed<T>, LogMeta)> = complete_indexer_log_data
            .into_iter()
            .map(|(tx_id, tx, data, log_index)| {
                let (block_hash, transaction_index) = transaction_map.get(&tx_id).unwrap();

                let log_meta = LogMeta {
                    address: self.contract_address.clone().into_h256(),
                    block_number: *tx.block_height.unwrap_or_default().deref() as u64,
                    block_hash: block_hash.into_h256(),
                    transaction_id: H512::from(tx_id.into_h256()),
                    transaction_index: transaction_index.to_owned(),
                    log_index,
                };

                (data.into(), log_meta)
            })
            .collect::<Vec<_>>();

        Ok(indexed_logs)
    }

    /// Get the custom Fuel Provider
    pub fn provider(&self) -> &FuelProvider {
        &self.fuel_provider
    }

    fn has_event(&self, tx_data: &TransactionResponse) -> bool {
        let decoder = &self.log_decoder;
        if let TxStatus::Success { receipts } = &tx_data.status {
            if let Ok(decoded_logs) = decoder.decode_logs_with_type::<E>(receipts) {
                return !decoded_logs.is_empty();
            }
        }
        false
    }

    fn append_with_event_data<T>(
        &self,
        filtered_transactions: Vec<(Bytes32, TransactionResponse)>,
    ) -> Vec<(Bytes32, TransactionResponse, T, U256)>
    where
        T: Into<Indexed<T>> + PartialEq + Send + Sync + Debug + 'static + From<E>,
    {
        let decoder = &self.log_decoder;
        // Iterate over the filtered transactions
        filtered_transactions
            .into_iter()
            .filter_map(|(tx_id, tx_data)| {
                // Get the receipts from each transaction
                if let TxStatus::Success { receipts } = &tx_data.status {
                    // Get the log index and the receipt log data
                    for (log_index, receipt) in receipts.iter().enumerate() {
                        // If the receipt contains the relevant log, we save the log and index
                        if let Ok(decoded_logs) =
                            decoder.decode_logs_with_type::<E>(&[receipt.clone()])
                        {
                            if !decoded_logs.is_empty() && decoded_logs.len() == 1 {
                                // Transform the event data into data used for indexing
                                let relevant_event = decoded_logs[0].clone().transform::<T>();
                                let log_index = U256::from(log_index as u64);
                                return Some((tx_id, tx_data, relevant_event, log_index));
                            }
                        }
                    }
                }
                None // Return None if no relevant event data was found
            })
            .collect::<Vec<_>>()
    }

    /// Check if a transaction is from a contract
    /// @note: Only works for checking script transactions
    #[allow(clippy::get_first)]
    fn is_transaction_from_contract(&self, res: &TransactionResponse) -> bool {
        if let TransactionType::Script(script_transaction) = &res.transaction {
            if script_transaction.inputs().iter().any(|input| {
                input
                    .contract_id()
                    .is_some_and(|id| id == &ContractId::from(&self.contract_address))
            }) {
                return true;
            }
        }
        false
    }

    async fn get_transaction_data(
        &self,
        transaction_map: &HashMap<Bytes32, (Bytes32, u64)>,
        cursor: Option<String>,
    ) -> ChainResult<Vec<(Bytes32, TransactionResponse)>> {
        let transaction_ids = transaction_map.keys().cloned().collect::<Vec<_>>();
        let req = PaginationRequest {
            cursor,
            results: transaction_ids.len() as i32,
            direction: PageDirection::Forward,
        };

        let transactions = self
            .fuel_provider
            .provider()
            .get_transactions(req)
            .await
            .map_err(ChainCommunicationError::from_other)?;

        let mut transaction_data = Vec::new();
        for (tx_data, tx_id) in transactions.results.iter().zip(transaction_ids) {
            transaction_data.push((tx_id.clone(), tx_data.clone()));
        }

        let filtered_transactions = transaction_data
            .into_iter()
            .filter(|(_, tx_data)| {
                self.is_transaction_from_contract(&tx_data) && self.has_event(tx_data)
            })
            .collect::<Vec<_>>();

        Ok(filtered_transactions)
    }

    async fn get_block_data(
        &self,
        range: RangeInclusive<u32>,
        cursor: Option<String>,
    ) -> ChainResult<(i32, HashMap<Bytes32, (Bytes32, u64)>)> {
        let result_amount: u32 = range.end() - range.start();
        let req = PaginationRequest {
            cursor,
            results: result_amount as i32,
            direction: PageDirection::Forward,
        };

        let blocks = self
            .fuel_provider
            .provider()
            .get_blocks(req)
            .await
            .map_err(ChainCommunicationError::from_other)?;

        let mut transaction_map: HashMap<Bytes32, (Bytes32, u64)> = HashMap::new();
        blocks.results.iter().for_each(|block| {
            block
                .transactions
                .iter()
                .enumerate()
                .for_each(|(index, tx)| {
                    transaction_map.insert(tx.clone(), (block.id, index as u64));
                });
        });

        let transaction_amount = blocks
            .results
            .iter()
            .fold(0, |acc: usize, block| acc + block.transactions.len())
            as i32;

        Ok((transaction_amount, transaction_map))
    }

    async fn get_sync_cursors(
        &self,
        range: &RangeInclusive<u32>,
    ) -> ChainResult<(Option<String>, Option<String>)> {
        let range_start = range.start();
        if *range_start == 0 {
            return Ok((None, None));
        }

        let start_block = BlockHeight::from(*range_start);
        let block_data = match self
            .fuel_provider
            .provider()
            .block_by_height(start_block)
            .await
            .map_err(ChainCommunicationError::from_other)?
        {
            Some(block) => block,
            None => {
                return Err(ChainCommunicationError::from_other_str(
                    "Block not found while building cursors",
                ))
            }
        };

        let first_transaction = match block_data.transactions.first() {
            Some(tx) => tx,
            None => {
                return Err(ChainCommunicationError::from_other_str(
                    "Failed to get first transaction in block while building cursors",
                ))
            }
        };

        let hex_block = hex::encode(range_start.to_be_bytes());
        let hex_tx = hex::encode(first_transaction.to_vec());

        let tx_cursor = Some(format!("{}#0x{}", hex_block, hex_tx));
        let block_cursor = Some(range_start.to_string());

        return Ok((block_cursor, tx_cursor));
    }
}
