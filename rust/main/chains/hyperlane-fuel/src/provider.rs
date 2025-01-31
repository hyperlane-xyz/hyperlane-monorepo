use crate::{make_client, make_provider, prelude::FuelIntoH256, ConnectionConf};

use async_trait::async_trait;
use fuels::{
    client::FuelClient,
    prelude::Provider,
    types::{Address, BlockHeight, ContractId},
};
use hyperlane_core::{
    h512_to_bytes, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError, TxnInfo, TxnReceiptInfo, H256,
    H512, U256,
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
                hash: block.id.into_h256(),
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

    /// Get a transaction by its hash
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let hash_parsed = H256::from_slice(&h512_to_bytes(hash));

        let transaction = self
            .provider
            .get_transaction_by_id(&hash_parsed.0.into())
            .await
            .map_err(|_| HyperlaneProviderError::CouldNotFindTransactionByHash(*hash))?
            .ok_or(HyperlaneProviderError::CouldNotFindTransactionByHash(*hash))?;

        let block_number = transaction.block_height.ok_or_else(|| {
            ChainCommunicationError::from_other_str(
                "Could not get block number from transaction data",
            )
        })?;

        let gas_price = self
            .provider
            .estimate_gas_price(block_number.into())
            .await
            .map_or(0, |estimate| estimate.gas_price);

        let receipts = transaction.status.take_receipts();

        let gas_used = receipts
            .iter()
            .filter_map(|receipt| receipt.gas_used())
            .next()
            .unwrap_or(0);
        let sender = receipts
            .iter()
            .filter_map(|receipt| receipt.sender())
            .next()
            .map(|sender| H256::from_slice(sender.as_slice()))
            .unwrap_or(H256::zero());
        let recipient = receipts
            .iter()
            .filter_map(|receipt| receipt.recipient())
            .next()
            .map(|recipient| H256::from_slice(recipient.as_slice()));
        let nonce = receipts
            .iter()
            .filter_map(|receipt| receipt.nonce())
            .next()
            .map(|nonce| {
                let mut arr = [0u8; 8];
                let nonce_bytes = <[u8; 32]>::from(*nonce);
                arr.copy_from_slice(&nonce_bytes[0..8]);
                u64::from_be_bytes(arr)
            })
            .unwrap_or(0);

        Ok(TxnInfo {
            hash: *hash,
            gas_limit: gas_used.into(),
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            nonce,
            sender,
            gas_price: Some(gas_price.into()),
            recipient,
            receipt: Some(TxnReceiptInfo {
                gas_used: gas_used.into(),
                cumulative_gas_used: gas_used.into(),
                effective_gas_price: Some(gas_price.into()),
            }),
            raw_input_data: None,
        })
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

    /// Get the base asset balance of an address
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

    /// Get the chain metrics for the latest block
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        let metrics = self
            .provider
            .latest_gas_price()
            .await
            .map_err(|_| ChainCommunicationError::from_other_str("Failed to get gas price"))?;
        let block_info = self
            .provider
            .block_by_height(metrics.block_height)
            .await
            .map_err(|_| {
                HyperlaneProviderError::CouldNotFindBlockByHeight(*metrics.block_height as u64)
            })?
            .ok_or_else(|| {
                HyperlaneProviderError::CouldNotFindBlockByHeight(*metrics.block_height as u64)
            })?;

        Ok(Some(ChainInfo {
            latest_block: BlockInfo {
                hash: block_info.id.into_h256(),
                timestamp: block_info.header.time.map_or(0, |t| t.timestamp() as u64),
                number: block_info.header.height.into(),
            },
            min_gas_price: Some(U256::from(metrics.gas_price)),
        }))
    }
}
