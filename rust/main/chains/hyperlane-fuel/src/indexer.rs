use crate::{conversions::*, ConnectionConf, FuelProvider};
use fuels::{
    accounts::wallet::WalletUnlocked,
    client::{PageDirection, PaginationRequest},
    tx::Receipt,
    types::{
        bech32::Bech32ContractId,
        transaction::{Transaction, TransactionType},
        transaction_response::TransactionResponse,
        tx_status::TxStatus,
        BlockHeight, Bytes32, ContractId,
    },
};
use futures::lock::Mutex;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Indexed, LogMeta, H512, U256,
};
use std::{
    collections::HashMap,
    fmt::Debug,
    ops::Deref,
    sync::atomic::{AtomicBool, Ordering},
};

// TODO, clippy issues

/// A wrapper around a fuel provider to get generic blockchain information.
#[derive(Debug)]
pub struct FuelIndexer {
    fuel_provider: FuelProvider,
    contract_address: Bech32ContractId,
    target_event_type: TransactionEventType,
    block_cursor: Mutex<Option<String>>,
    transaction_cursor: Mutex<Option<String>>,
    cursors_initialized: AtomicBool,
}

/// IGP payment log has a data length of 48 bytes
const IGP_PAYMENT_LOG_LENGTH: usize = 48;
/// Dispatch is the only function call on the mailbox that has 2 log data receipts
const DISPATCH_LOG_DATA_REC_AMOUNT: usize = 2;

/// Types of transaction logs that can be indexed
#[derive(Debug, Clone)]
pub enum TransactionEventType {
    /// Event when a Mailbox dispatches a message
    MailboxDispatch,
    /// Event when and IGP payment is processed
    IgpPayment,
    /// Event when a MerkleTreeHook insertion is processed
    MerkleTreeHookInsert,
}

impl FuelIndexer {
    /// Create a new fuel indexer
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        wallet: WalletUnlocked,
        target_event_type: TransactionEventType,
    ) -> Self {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;
        let contract_address = Bech32ContractId::from_h256(&locator.address);

        Self {
            fuel_provider,
            contract_address,
            target_event_type,
            block_cursor: Mutex::new(None),
            transaction_cursor: Mutex::new(None),
            cursors_initialized: AtomicBool::default(),
        }
    }

    /// Index logs depending on which transaction parser is passed as a parameter
    pub async fn index_logs_in_range<T>(
        &self,
        range: std::ops::RangeInclusive<u32>,
        parser: fn(
            Vec<(Bytes32, TransactionResponse)>,
        ) -> Vec<(Bytes32, TransactionResponse, T, U256)>,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>>
    where
        T: Into<Indexed<T>>,
        T: PartialEq + Send + Sync + Debug + 'static,
    {
        if !self.cursors_initialized.load(Ordering::Relaxed) {
            self.initialize_cursors(&range).await;
        }

        let (transaction_amount, transaction_map) = self.get_block_data(range).await.unwrap();
        let transaction_data = self.get_transaction_data(&transaction_map).await;

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
    /// Assumes that the first input is the contract id
    #[allow(clippy::get_first)]
    fn is_transaction_from_contract(
        res: &TransactionResponse,
        contract: &Bech32ContractId,
    ) -> bool {
        if let TransactionType::Script(script_transaction) = &res.transaction {
            if script_transaction.inputs().get(0).is_some_and(|input| {
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
    ) -> Vec<(Bytes32, TransactionResponse)> {
        let transaction_ids = transaction_map.keys().cloned().collect::<Vec<_>>();
        let req = PaginationRequest {
            cursor: self.transaction_cursor.lock().await.clone(),
            results: transaction_ids.len() as i32,
            direction: PageDirection::Forward,
        };

        let transactions = self
            .fuel_provider
            .provider()
            .get_transactions(req)
            .await
            .map_err(ChainCommunicationError::from_other)
            .unwrap();

        *self.transaction_cursor.lock().await = transactions.cursor.clone();

        assert!(
            transactions.results.len() == transaction_ids.len(),
            "Transaction data amount does not match transaction id amount"
        );

        let mut transaction_data = Vec::new();
        for (tx_id, tx_data) in transactions.results.iter().zip(transaction_ids) {
            transaction_data.push((tx_data.clone(), tx_id.clone()));
        }

        let transaction_matcher = self.get_transaction_matcher();

        transaction_data
            .into_iter()
            .filter(|(_, tx_data)| {
                Self::is_transaction_from_contract(&tx_data, &self.contract_address)
                    && transaction_matcher(&tx_data)
            })
            .collect::<Vec<_>>()
    }

    async fn get_block_data(
        &self,
        range: std::ops::RangeInclusive<u32>,
    ) -> ChainResult<(i32, HashMap<Bytes32, (Bytes32, u64)>)> {
        let result_amount = range.end() - range.start() + 1;
        let req = PaginationRequest {
            cursor: self.block_cursor.lock().await.clone(),
            results: i32::try_from(result_amount).expect("Invalid range"),
            direction: PageDirection::Forward,
        };

        let blocks = self
            .fuel_provider
            .provider()
            .get_blocks(req)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        *self.block_cursor.lock().await = blocks.cursor.clone();

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

    async fn initialize_cursors(&self, range: &std::ops::RangeInclusive<u32>) {
        let mut block_cursor_guard = self.block_cursor.lock().await;
        let mut transaction_cursor_guard = self.transaction_cursor.lock().await;
        assert!(
            block_cursor_guard.is_none() && transaction_cursor_guard.is_none(),
            "Cursors already initialized"
        );

        let range_start = range.start();
        if range.start() == &0 {
            self.cursors_initialized.store(true, Ordering::Relaxed);
            return;
        }

        let start_block = BlockHeight::from(*range_start);
        let block_data = self
            .fuel_provider
            .provider()
            .block_by_height(start_block)
            .await
            .expect("Failed to get block data")
            .unwrap();
        let first_transaction = block_data.transactions.first().unwrap();

        let hex_block = hex::encode(range_start.to_be_bytes());
        let hex_tx = hex::encode(first_transaction.to_vec());
        let tx_cursor = Some(format!("{}#0x{}", hex_block, hex_tx));
        let block_cursor = Some(range_start.to_string());

        *block_cursor_guard = block_cursor;
        *transaction_cursor_guard = tx_cursor;
        self.cursors_initialized.store(true, Ordering::Relaxed);
    }
}

// Functions to make sure that the correct function is being filtered
impl FuelIndexer {
    /// Get the correct function to validate a transaction depending on the indexer event target
    fn get_transaction_matcher(&self) -> for<'a> fn(&'a TransactionResponse) -> bool {
        match self.target_event_type {
            TransactionEventType::MailboxDispatch => Self::is_dispatch_call,
            TransactionEventType::IgpPayment => Self::is_igp_payment,
            TransactionEventType::MerkleTreeHookInsert => Self::is_merkle_tree_insertion,
        }
    }

    /// Check if a transaction is a call to the dispatch function of the Mailbox contract
    fn is_dispatch_call(res: &TransactionResponse) -> bool {
        let receipts = match &res.status {
            TxStatus::Success { receipts } => receipts,
            _ => return false,
        };

        let log_data_receipts = Self::filter_logdata_rec(receipts);

        match log_data_receipts.len() {
            DISPATCH_LOG_DATA_REC_AMOUNT => true,
            _ => false,
        }
    }

    /// Check if a transaction is a call to the post dispatch function of the MerkleTreeHook contract
    fn is_merkle_tree_insertion(res: &TransactionResponse) -> bool {
        let receipts = match &res.status {
            TxStatus::Success { receipts } => receipts,
            _ => return false,
        };

        let log_data_receipts = Self::filter_logdata_rec(receipts);

        // Merkle tree insertion is the only function which has a single log data receipt
        match log_data_receipts.len() {
            1 => true,
            _ => false,
        }
    }

    /// Check if a transaction is a call to the pay_for_gas function of the IGP Hook contract
    fn is_igp_payment(res: &TransactionResponse) -> bool {
        let receipts = match &res.status {
            TxStatus::Success { receipts } => receipts,
            _ => return false,
        };

        let log_data_receipts = Self::filter_logdata_rec(receipts);

        assert!(
            log_data_receipts.len() == 1,
            "IGP payment should have 1 log data receipt"
        );
        let log = log_data_receipts.get(0).unwrap();

        match log {
            Receipt::LogData { data, .. } => data
                .to_owned()
                .is_some_and(|data| data.len() == IGP_PAYMENT_LOG_LENGTH),
            _ => false,
        }
    }

    /// Retrieve only the logdata receipts
    fn filter_logdata_rec(receipts: &Vec<Receipt>) -> Vec<&Receipt> {
        receipts
            .into_iter()
            .filter(|rec| match rec {
                Receipt::LogData { .. } => true,
                _ => false,
            })
            .collect::<Vec<_>>()
    }
}
