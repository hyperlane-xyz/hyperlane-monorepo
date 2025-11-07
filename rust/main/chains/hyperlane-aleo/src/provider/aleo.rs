use std::{ops::Deref, str::FromStr};

use crate::{
    provider::{BaseHttpClient, RpcClient},
    utils::{get_tx_id, to_h256},
    ConnectionConf, HyperlaneAleoError,
};
use async_trait::async_trait;
use reqwest::Client;
use snarkvm::prelude::{CanaryV0, MainnetV0, TestnetV0};
use snarkvm_console_account::Address;

use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain, HyperlaneProvider, TxnInfo,
    TxnReceiptInfo, H256, H512, U256,
};

/// Aleo Rest Client
#[derive(Debug, Clone)]
pub struct AleoProvider {
    client: RpcClient<BaseHttpClient>,
    domain: HyperlaneDomain,
    network: u16,
}

impl AleoProvider {
    /// Creates a new HTTP client for the Aleo API
    pub fn new(conf: &ConnectionConf, domain: HyperlaneDomain) -> ChainResult<Self> {
        let base_url = conf.rpc.to_string().trim_end_matches('/').to_string();
        let client = BaseHttpClient::new(Client::new(), base_url);

        Ok(Self {
            client: RpcClient::new(client),
            domain,
            network: conf.chain_id,
        })
    }

    /// Returns the chain id of the configured network
    pub fn chain_id(&self) -> u16 {
        self.network
    }
}

impl Deref for AleoProvider {
    type Target = RpcClient<BaseHttpClient>;
    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

impl HyperlaneChain for AleoProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for AleoProvider {
    /// Get block info for a given block height
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let height = height as u32;
        let (hash, timestamp) = match self.chain_id() {
            0 => {
                let block = self.get_block::<MainnetV0>(height).await?;
                (to_h256(&block)?, block.timestamp())
            }
            1 => {
                let block = self.get_block::<TestnetV0>(height).await?;
                (to_h256(&block)?, block.timestamp())
            }
            2 => {
                let block = self.get_block::<CanaryV0>(height).await?;
                (to_h256(&block)?, block.timestamp())
            }
            id => return Err(HyperlaneAleoError::UnknownNetwork(id).into()),
        };
        Ok(BlockInfo {
            hash,
            timestamp: timestamp as u64,
            number: height.into(),
        })
    }

    /// Get txn info for a given txn hash
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let tx_id = get_tx_id(*hash)?;
        let tx_id = tx_id.to_string();
        let transaction = self.get_transaction(&tx_id).await?;
        // Aleo doesn't have a concept of gas, we use the paid tokens as the gas limit and say that the gas_price is always one
        let gas_limit = transaction.fee_amount().map(|x| *x).unwrap_or(0u64);

        // We assume that the fee payer is the sender of the transaction
        let sender = transaction
            .fee_transition()
            .and_then(|fee_tx| fee_tx.payer())
            .map(to_h256)
            .transpose()?
            .unwrap_or_else(H256::zero);

        // Assume that the first transitions program id is the recipient of the transaction
        // One transaction can actually have multiple recipients
        let recipient = transaction
            .transitions()
            .next()
            .map(|transition| transition.program_id().to_address())
            .transpose()
            .map_err(HyperlaneAleoError::from)?
            .map(to_h256)
            .transpose()?;

        Ok(TxnInfo {
            hash: *hash,
            gas_limit: gas_limit.into(),
            max_priority_fee_per_gas: None,
            max_fee_per_gas: Some(U256::one()),
            gas_price: Some(U256::one()),
            nonce: 0, // Aleo doesn't have nonces, they use different random seeds upon ZKP generation as a replay protection
            sender,
            recipient,
            receipt: Some(TxnReceiptInfo {
                gas_used: gas_limit.into(),
                cumulative_gas_used: gas_limit.into(),
                effective_gas_price: Some(U256::one()),
            }),
            raw_input_data: None,
        })
    }

    /// Returns whether a contract exists at the provided address
    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        // We can't check whether ot not an address is a deploy contract on aleo
        // We can only check when we have the ProgramID
        Ok(true)
    }

    /// Fetch the balance of the wallet address associated with the chain provider.
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let address = Address::from_str(&address).map_err(HyperlaneAleoError::from)?;
        let balance: u64 = self
            .get_mapping_value("credits.aleo", "account", &address)
            .await?;
        Ok(U256::from(balance))
    }

    /// Fetch metrics related to this chain
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        let height = self.get_latest_height().await?;
        let info = self.get_block_by_height(height as u64).await?;
        Ok(Some(ChainInfo {
            latest_block: info,
            min_gas_price: None,
        }))
    }
}
