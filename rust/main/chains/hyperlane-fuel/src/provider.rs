use std::{collections::HashMap, ops::Deref};

use async_trait::async_trait;
use fuels::{
    client::{FuelClient, PageDirection, PaginationRequest},
    prelude::Provider,
    tx::Receipt,
    types::{
        bech32::Bech32ContractId,
        block::Block,
        gas_price::LatestGasPrice,
        transaction::{Transaction, TransactionType},
        transaction_response::TransactionResponse,
        tx_status::TxStatus,
        Address, BlockHeight, Bytes32, ContractId,
    },
};
use futures::future::join_all;
use hyperlane_core::{
    h512_to_bytes, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, HyperlaneProviderError, Indexed, LogMeta,
    TxnInfo, H256, H512, U256,
};

use crate::{make_client, make_provider, prelude::FuelIntoH256, ConnectionConf};

/// A wrapper around a fuel provider to get generic blockchain information.
#[derive(Debug, Clone)]
pub struct FuelProvider {
    domain: HyperlaneDomain,
    provider: Provider,
    client: FuelClient,
}

impl FuelProvider {
    /// Create a new fuel provider
    pub async fn new(domain: HyperlaneDomain, conf: &ConnectionConf) -> Self {
        let provider = make_provider(conf).await.unwrap();
        let client = make_client(conf).unwrap();

        Self {
            domain,
            provider,
            client,
        }
    }

    /// Get the inner provider
    pub fn provider(&self) -> &Provider {
        &self.provider
    }

    /// Get the latest gas price
    pub async fn get_gas_price(&self) -> ChainResult<u64> {
        let LatestGasPrice { gas_price, .. } = self
            .provider()
            .latest_gas_price()
            .await
            .map_err(ChainCommunicationError::from_other)?;

        Ok(gas_price)
    }

    /// Check if a transaction is from a contract
    /// @note: Only works for checking script transactions
    /// Assumes that the first input is the contract id
    #[allow(clippy::get_first)] // TODO: `rustc` 1.80.1 clippy issue
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

    /// Check if a transaction is a call to the dispatch function of the Mailbox contract
    #[allow(clippy::match_like_matches_macro)] // TODO: `rustc` 1.80.1 clippy issue
    #[allow(clippy::into_iter_on_ref)] // TODO: `rustc` 1.80.1 clippy issue
    fn is_dispatch_call(res: &TransactionResponse) -> bool {
        // let selector = encode_fn_selector("dispatch");
        // println!("selector: {:?}", selector); // XXX see if we can get the correct txn by selector
        // Apparently we should be able to see it in the call logs

        let receipts = match &res.status {
            TxStatus::Success { receipts } => receipts,
            _ => return false,
        };
        let log_data_receipts = receipts
            .into_iter()
            .filter(|rec| {
                // if let Receipt::Call { param1, param2, .. } = rec {
                //     print!(
                //         "param1: {:?}, param2: {:?}",
                //         param1.to_be_bytes(),
                //         param2.to_be_bytes()
                //     );
                // }

                match rec {
                    Receipt::LogData { .. } => true,
                    _ => false,
                }
            })
            .collect::<Vec<_>>();

        // Dispatch is the only call that has 2 log data receipts
        match log_data_receipts.len() {
            2 => true,
            _ => false,
        }
    }

    #[allow(clippy::clone_on_copy)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_block_data(
        &self,
        range: std::ops::RangeInclusive<u32>,
    ) -> ChainResult<(Vec<Block>, HashMap<Bytes32, (Bytes32, u64)>)> {
        let result_amount = range.end() - range.start() + 1;
        let req = PaginationRequest {
            cursor: Some(range.start().to_string()),
            results: i32::try_from(result_amount).expect("Invalid range"),
            direction: PageDirection::Forward,
        };

        let blocks = self
            .provider
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
        Ok((blocks.results, transaction_map))
    }

    /// Get the finalized block number
    /// XXX might be inaccurate as we do not know the block finality
    pub async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.provider
            .latest_block_height()
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    /// index logs in a range
    #[allow(clippy::clone_on_copy)] // TODO: `rustc` 1.80.1 clippy issue
    #[allow(clippy::manual_map)] // TODO: `rustc` 1.80.1 clippy issue
    #[allow(clippy::into_iter_on_ref)] // TODO: `rustc` 1.80.1 clippy issue
    #[allow(clippy::needless_borrow)] // TODO: `rustc` 1.80.1 clippy issue
    pub async fn index_logs_in_range(
        &self,
        range: std::ops::RangeInclusive<u32>,
        mailbox_contract: Bech32ContractId,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        let (blocks, transaction_map) = self.get_block_data(range.clone()).await.unwrap();

        // Transaction ids from selected blocks
        let transaction_ids = blocks
            .into_iter()
            .map(|block| block.transactions)
            .flat_map(|txs| txs.into_iter())
            .collect::<Vec<_>>();

        let futures = transaction_ids
            .into_iter()
            .map(|tx_id| {
                let provider = self.provider.clone();
                let tx_clone = tx_id.clone();
                async move {
                    let result = provider.get_transaction_by_id(&tx_id).await.unwrap();
                    (tx_clone, result)
                }
            })
            .collect::<Vec<_>>();

        // Filter transactions
        // 1. Transaction type is Script
        // 2. Transaction status is Success
        // 3. Transaction is from mailbox contract
        // 4. Transaction is a dispatch call
        // 5. Transaction data is valid
        let transaction_data = join_all(futures)
            .await
            .into_iter()
            .filter_map(|(tx_id, tx_data)| match tx_data {
                Some(tx_data) => Some((tx_id, tx_data)),
                _ => None,
            })
            .filter(|(_, tx_data)| {
                matches!(tx_data.transaction, TransactionType::Script(_))
                    && matches!(tx_data.status, TxStatus::Success { .. })
                    && Self::is_transaction_from_contract(&tx_data, &mailbox_contract)
                    && Self::is_dispatch_call(&tx_data)
            })
            .collect::<Vec<_>>();

        // Full data needed to construct the logs
        let full_tx_data = transaction_data
            .into_iter()
            .filter_map(|(tx_id, tx_data)| {
                let receipts = match &tx_data.status {
                    TxStatus::Success { receipts } => receipts,
                    _ => return None,
                };

                let (log_index, mut receipt_log_data) = receipts
                    .into_iter()
                    .enumerate()
                    .filter_map(|(log_index, rec)| {
                        // We only care about LogData receipts with data length greater than 32 bytes
                        match rec {
                            Receipt::LogData { .. }
                                if rec.data().is_some_and(|data| data.len() > 32) =>
                            {
                                let data = rec.data().map(|data| data.to_owned());

                                match data {
                                    Some(data) => Some((U256::from(log_index), data)),
                                    _ => None,
                                }
                            }
                            _ => None,
                        }
                    })
                    .next()?; // Each dispatch call should have only one log data receipt

                if !receipt_log_data.is_empty() {
                    // We cut out the message id, recipient and domain which are encoded in the first 76 bytes
                    receipt_log_data.drain(0..76);
                    let encoded_message = HyperlaneMessage::from(receipt_log_data);
                    Some((tx_id, tx_data, encoded_message, log_index))
                } else {
                    None
                }
            })
            .collect::<Vec<(Bytes32, TransactionResponse, HyperlaneMessage, U256)>>(); // Collect all Vec<u8> from each transaction into a Vec<Vec<u8>>

        let indexed_logs: Vec<(Indexed<HyperlaneMessage>, LogMeta)> = full_tx_data
            .into_iter()
            .map(|(tx_id, tx, message, log_index)| {
                let (block_hash, transaction_index) = transaction_map.get(&tx_id).unwrap();

                let log_meta = LogMeta {
                    address: mailbox_contract.clone().into_h256(),
                    block_number: *tx.block_height.unwrap().deref() as u64,
                    block_hash: block_hash.into_h256(),
                    transaction_id: H512::from(tx_id.into_h256()),
                    transaction_index: transaction_index.clone(),
                    log_index,
                };
                (message.into(), log_meta)
            })
            .collect::<Vec<_>>();
        Ok(indexed_logs)
    }
}

impl HyperlaneChain for FuelProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for FuelProvider {
    /// Used by scraper
    #[allow(clippy::clone_on_copy)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let block_res = self
            .provider
            .block_by_height(BlockHeight::new(height as u32))
            .await
            .map_err(|e| HyperlaneProviderError::CouldNotFindBlockByHeight(height))?;

        let block_info = match block_res {
            Some(block) => BlockInfo {
                hash: H256::from_slice(block.id.as_slice()),
                timestamp: block.header.time.map_or(0, |t| t.timestamp() as u64),
                number: block.header.height.into(),
            },
            None => Err(HyperlaneProviderError::CouldNotFindBlockByHeight(height))?,
        };

        if block_info.number != height {
            Err(HyperlaneProviderError::IncorrectBlockByHeight(
                height,
                block_info.number,
            ))?;
        }

        Ok(block_info)
    }

    /// Used by scraper
    #[allow(clippy::clone_on_copy)] // TODO: `rustc` 1.80.1 clippy issue
    #[allow(clippy::match_like_matches_macro)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let hash = H256::from_slice(&h512_to_bytes(hash));

        let transaction_res = self
            .provider
            .get_transaction_by_id(&hash.0.into())
            .await
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!("Failed to get transaction: {}", e))
            })?;

        match transaction_res {
            Some(transaction) => {
                let block_number = transaction.block_height.unwrap();

                let gas_price = self
                    .provider
                    .estimate_gas_price(block_number.into())
                    .await
                    .map_or(0, |estimate| estimate.gas_price);

                let gas_limit = match transaction.transaction {
                    TransactionType::Script(tx) => tx.gas_limit(),
                    _ => 0,
                };

                let (sender, recipient, nonce) = match transaction.status {
                    TxStatus::Success { receipts } => {
                        let valid_receipt = receipts.into_iter().find(|receipt| match receipt {
                            Receipt::MessageOut { .. } => true,
                            _ => false,
                        });

                        match valid_receipt {
                            Some(Receipt::MessageOut {
                                sender,
                                recipient,
                                nonce,
                                ..
                            }) => {
                                let mut arr = [0u8; 8];
                                let nonce_bytes = <[u8; 32]>::from(nonce);
                                arr.copy_from_slice(&nonce_bytes[0..8]);
                                let parsed_nonce = u64::from_be_bytes(arr);

                                (
                                    <[u8; 32]>::from(sender).into(),
                                    Some(<[u8; 32]>::from(recipient).into()),
                                    parsed_nonce,
                                )
                            }
                            _ => (H256::zero(), None, 0),
                        }
                    }
                    _ => (H256::zero(), None, 0),
                };

                Ok(TxnInfo {
                    hash: hash.into(),
                    gas_limit: gas_limit.into(),
                    max_priority_fee_per_gas: None,
                    max_fee_per_gas: None,
                    nonce,
                    sender,
                    gas_price: Some(gas_price.into()),
                    recipient,
                    receipt: None,
                    raw_input_data: None,
                })
            }
            None => Err(ChainCommunicationError::CustomError(format!(
                "Transaction not found: {}",
                hash
            ))),
        }
    }

    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        let contract_res = self.client.contract(&ContractId::from(address.0)).await;

        match contract_res {
            Ok(contract) => Ok(contract.is_some()),
            Err(e) => Err(ChainCommunicationError::CustomError(format!(
                "Failed to get contract: {}",
                e
            ))),
        }
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let base = self.provider.base_asset_id();
        let asset = *Address::from_bytes_ref_checked(address.as_bytes()).expect("Invalid address");

        self.provider
            .get_asset_balance(&asset.into(), *base)
            .await
            .map(|balance| Ok(U256::from(balance)))
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!("Failed to get balance: {}", e))
            })?
    }

    /// Used by hyperlane base metrics (scraper)
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Ok(None)
    }
}
