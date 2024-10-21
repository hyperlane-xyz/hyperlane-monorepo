use crate::{
    contracts::interchain_gas_paymaster::{
        GasPaymentEvent, InterchainGasPaymaster as FuelIgpContract,
    },
    contracts::mailbox::{DispatchEvent, Mailbox as FuelMailboxContract},
    contracts::merkle_tree_hook::{MerkleTreeEvent, MerkleTreeHook as FuelMerkleTreeHookContract},
    conversions::*,
    ConnectionConf, FuelProvider,
};
use fuels::{
    accounts::wallet::WalletUnlocked,
    client::{PageDirection, PaginationRequest},
    core::{
        codec::LogDecoder,
        traits::{Parameterize, Tokenizable},
    },
    programs::calls::ContractDependency,
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
    ops::{Deref, RangeInclusive},
};

// TODO, clippy issues

/// A wrapper around a fuel provider to get generic blockchain information.
pub struct FuelIndexer {
    fuel_provider: FuelProvider,
    contract_address: Bech32ContractId,
    event_checker: Box<dyn Fn(&TransactionResponse) -> bool + Sync + Send>,
}

// Implementing Debug for FuelIndexer
impl std::fmt::Debug for FuelIndexer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FuelIndexer")
            .field("fuel_provider", &self.fuel_provider)
            .field("contract_address", &self.contract_address)
            .field("event_checker", &"<transaction_event_checker_closure>")
            .finish()
    }
}
/// Trait for getting decoders from different contracts depending on the event type
pub trait HasLogDecoder {
    /// Get the log decoder for a specific contract
    fn log_decoder(contract_address: Bech32ContractId, wallet: WalletUnlocked) -> LogDecoder;
}

impl HasLogDecoder for DispatchEvent {
    fn log_decoder(contract_address: Bech32ContractId, wallet: WalletUnlocked) -> LogDecoder {
        FuelMailboxContract::new(contract_address, wallet).log_decoder()
    }
}

impl HasLogDecoder for GasPaymentEvent {
    fn log_decoder(contract_address: Bech32ContractId, wallet: WalletUnlocked) -> LogDecoder {
        FuelIgpContract::new(contract_address, wallet).log_decoder()
    }
}

impl HasLogDecoder for MerkleTreeEvent {
    fn log_decoder(contract_address: Bech32ContractId, wallet: WalletUnlocked) -> LogDecoder {
        FuelMerkleTreeHookContract::new(contract_address, wallet).log_decoder()
    }
}

impl FuelIndexer {
    /// Create a new fuel indexer
    /// -`T` is the type of event this indexer will be looking for
    pub async fn new<T>(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        wallet: WalletUnlocked,
    ) -> Self
    where
        T: Tokenizable + Parameterize + HasLogDecoder + 'static,
    {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;
        let contract_address = Bech32ContractId::from_h256(&locator.address);

        let decoder = T::log_decoder(contract_address.clone(), wallet);

        let has_event_fn: Box<dyn Fn(&TransactionResponse) -> bool + Send + Sync> =
            Box::new(move |tx_data: &TransactionResponse| -> bool {
                if let TxStatus::Success { receipts } = &tx_data.status {
                    if let Ok(decoded_logs) = decoder.decode_logs_with_type::<T>(receipts) {
                        return !decoded_logs.is_empty();
                    }
                }
                false
            });

        Self {
            fuel_provider,
            contract_address,
            event_checker: has_event_fn,
        }
    }

    /// Index logs depending on which transaction parser is passed as a parameter
    /// - `T` is the type of the indexed data
    pub async fn index_logs_in_range<T>(
        &self,
        range: RangeInclusive<u32>,
        parser: fn(
            Vec<(Bytes32, TransactionResponse)>,
        ) -> Vec<(Bytes32, TransactionResponse, T, U256)>,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>>
    where
        T: Into<Indexed<T>>,
        T: PartialEq + Send + Sync + Debug + 'static,
    {
        let (block_cursor, transaction_cursor) = self.get_sync_cursors(&range).await?;

        let (transaction_amount, transaction_map) = self
            .get_block_data(range.clone(), block_cursor.clone())
            .await?;
        let transaction_data = self
            .get_transaction_data(&transaction_map, transaction_cursor.clone())
            .await?;

        let full_tx_data = parser(transaction_data);

        let indexed_logs: Vec<(Indexed<T>, LogMeta)> = full_tx_data
            .into_iter()
            .map(|(tx_id, tx, data, log_index)| {
                let (block_hash, transaction_index) = transaction_map.get(&tx_id).unwrap();

                let log_meta = LogMeta {
                    address: self.contract_address.clone().into_h256(),
                    block_number: *tx.block_height.unwrap().deref() as u64,
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

    /// Check if a transaction is from a contract
    /// @note: Only works for checking script transactions
    #[allow(clippy::get_first)]
    fn is_transaction_from_contract(
        res: &TransactionResponse,
        contract: &Bech32ContractId,
    ) -> bool {
        if let TransactionType::Script(script_transaction) = &res.transaction {
            if script_transaction.inputs().iter().any(|input| {
                input
                    .contract_id()
                    .is_some_and(|id| id == &ContractId::from(&contract.into()))
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
        for (tx_id, tx_data) in transactions.results.iter().zip(transaction_ids) {
            transaction_data.push((tx_data.clone(), tx_id.clone()));
        }

        let filtered_transactions = transaction_data
            .into_iter()
            .filter(|(_, tx_data)| {
                Self::is_transaction_from_contract(&tx_data, &self.contract_address)
                    && (self.event_checker)(tx_data)
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
        let block_data = self
            .fuel_provider
            .provider()
            .block_by_height(start_block)
            .await
            .map_err(ChainCommunicationError::from_other)
            .map(|block| block.unwrap())?;

        let first_transaction = block_data.transactions.first().unwrap();

        let hex_block = hex::encode(range_start.to_be_bytes());
        let hex_tx = hex::encode(first_transaction.to_vec());

        let tx_cursor = Some(format!("{}#0x{}", hex_block, hex_tx));
        let block_cursor = Some(range_start.to_string());

        return Ok((block_cursor, tx_cursor));
    }
}
