use crate::{make_client, make_provider, ConnectionConf};
use async_trait::async_trait;
use fuels::{
    client::FuelClient,
    prelude::Provider,
    tx::Receipt,
    types::{transaction::TransactionType, tx_status::TxStatus, Address, BlockHeight, ContractId},
};
use hyperlane_core::{
    h512_to_bytes, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError, TxnInfo, H256, H512, U256,
};

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
        self.provider
            .latest_gas_price()
            .await
            .map_err(ChainCommunicationError::from_other)
            .map(|res| res.gas_price)
    }

    /// Get the finalized block number
    /// Since FuelVM has instant finality, this is the same as the latest block number
    pub async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.provider
            .latest_block_height()
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    /// Extract transaction data from receipts
    fn extract_transaction_data(receipts: Vec<Receipt>) -> (H256, Option<H256>, u64) {
        let valid_receipt = receipts
            .into_iter()
            .find(|receipt| matches!(receipt, Receipt::MessageOut { .. }));

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
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let block_res = self
            .provider
            .block_by_height(BlockHeight::new(height as u32))
            .await
            .map_err(|_| HyperlaneProviderError::CouldNotFindBlockByHeight(height))?;

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
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let hash_parsed = H256::from_slice(&h512_to_bytes(hash));

        let transaction_res = self
            .provider
            .get_transaction_by_id(&hash_parsed.0.into())
            .await
            .map_err(|_| HyperlaneProviderError::CouldNotFindTransactionByHash(*hash))?;

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
                    TxStatus::Success { receipts } => Self::extract_transaction_data(receipts),
                    _ => (H256::zero(), None, 0),
                };

                Ok(TxnInfo {
                    hash: *hash,
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
                "Failed to query contract: {}",
                e
            ))),
        }
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let base = self.provider.base_asset_id();
        let address_bytes = hex::decode(&address)?;
        let address = *Address::from_bytes_ref_checked(address_bytes.as_slice()).ok_or(
            ChainCommunicationError::CustomError(format!("Invalid address: {}", address)),
        )?;

        self.provider
            .get_asset_balance(&address.into(), *base)
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
