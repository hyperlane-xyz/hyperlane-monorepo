use ethers::providers::Middleware;
use ethers_core::types::{BlockId, BlockNumber};
use std::{fmt, time::Duration};
use url::Url;

use hyperlane_core::{
    config::OpSubmissionConfig, utils::hex_or_base58_or_bech32_to_h256, ChainCommunicationError,
    ChainResult, HyperlaneMessage, ReorgPeriod, Secret, H256, U256,
};

/// Protected RPCs for matching delivery preflights and EVM Lander submission.
#[derive(Clone)]
pub struct MevSubmissionConfig {
    /// Endpoints that preserve transaction privacy, with no public fallback.
    pub rpc_urls: Secret<Vec<Url>>,
    /// Canonical ICA router receiving reveal messages on this chain.
    pub ica_router: H256,
    /// Other deployed ICA router versions protected by the same endpoints.
    pub additional_ica_routers: Vec<H256>,
}

impl MevSubmissionConfig {
    /// Protect messages addressed to the ICA router with reveal type, regardless
    /// of origin or sender. Reveals do not enforce remote-router enrollment.
    /// Commits use ordinary RPCs.
    pub fn matches(&self, message: &HyperlaneMessage) -> bool {
        const ICA_REVEAL: u8 = 2;
        (message.recipient == self.ica_router
            || self.additional_ica_routers.contains(&message.recipient))
            && message.body.first() == Some(&ICA_REVEAL)
    }
}

impl fmt::Debug for MevSubmissionConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MevSubmissionConfig")
            .field("endpoint_count", &self.rpc_urls.expose_secret().len())
            .field("ica_router", &self.ica_router)
            .field("additional_ica_routers", &self.additional_ica_routers)
            .finish()
    }
}

static BATCH_CONTRACT_ADDRESS_DEFAULT: &str = "0xcA11bde05977b3631167028862bE2a173976CA11";

/// Configuration for speculative fallback RPC reads.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FallbackHedgeConfig {
    /// Grace period before starting a request to the next provider.
    pub delay: Duration,
    /// Timeout applied independently to every hedged provider attempt.
    pub attempt_timeout: Duration,
}

/// Ethereum RPC connection configuration
#[derive(Debug, Clone)]
pub enum RpcConnectionConf {
    /// An HTTP-only quorum.
    HttpQuorum {
        /// List of urls to connect to
        urls: Secret<Vec<Url>>,
    },
    /// An HTTP-only fallback set.
    HttpFallback {
        /// List of urls to connect to in order of priority
        urls: Secret<Vec<Url>>,
    },
    /// HTTP connection details
    Http {
        /// Url to connect to
        url: Secret<Url>,
    },
    /// Websocket connection details
    Ws {
        /// Url to connect to
        url: Secret<Url>,
    },
}

impl Default for RpcConnectionConf {
    fn default() -> Self {
        RpcConnectionConf::HttpFallback {
            urls: Secret::new(vec![]),
        }
    }
}

/// Ethereum connection configuration
#[derive(Clone, Debug, Default)]
pub struct ConnectionConf {
    /// RPC connection configuration
    pub rpc_connection: RpcConnectionConf,
    /// Transaction overrides to use when sending transactions.
    pub transaction_overrides: TransactionOverrides,
    /// Operation batching configuration
    pub op_submission_config: OpSubmissionConfig,
    /// If enabled and eth_getTransactionReceipt returns Ok(Value::null())
    /// we will try other providers and see if another provider returns something
    /// non-null
    pub consider_null_transaction_receipt: bool,
    /// Optional hedging for explicitly allowlisted immutable/finalized reads.
    /// Disabled when unset.
    pub fallback_hedge: Option<FallbackHedgeConfig>,
    /// Optional protected RPC policy for delivery estimates and EVM Lander submission.
    pub mev_submission: Option<MevSubmissionConfig>,
}

impl ConnectionConf {
    /// Returns the RPC urls for this connection configuration
    #[allow(clippy::panic)]
    pub fn rpc_urls(&self) -> Vec<Url> {
        use RpcConnectionConf::{Http, HttpFallback, HttpQuorum, Ws};

        match &self.rpc_connection {
            HttpQuorum { urls } | HttpFallback { urls } => urls.expose_secret().clone(),
            Http { url } => vec![url.expose_secret().clone()],
            Ws { .. } => panic!("Websocket connection is not supported"),
        }
    }

    /// Returns the address of the contract which batches operations.
    pub fn batch_contract_address(&self) -> H256 {
        self.op_submission_config
            .batch_contract_address
            .unwrap_or_else(|| {
                hex_or_base58_or_bech32_to_h256(BATCH_CONTRACT_ADDRESS_DEFAULT)
                    .expect("Invalid default batch contract address")
            })
    }
}

/// Ethereum transaction overrides.
#[derive(Debug, Clone, Default)]
pub struct TransactionOverrides {
    /// Gas price to use for transactions, in wei.
    /// If specified, non-1559 transactions will be used with this gas price.
    pub gas_price: Option<U256>,
    /// Gas limit to use for transactions.
    /// If unspecified, the gas limit will be estimated.
    /// If specified, transactions will use `max(estimated_gas, gas_limit)`
    pub gas_limit: Option<U256>,
    /// Max fee per gas to use for EIP-1559 transactions.
    pub max_fee_per_gas: Option<U256>,
    /// Max priority fee per gas to use for EIP-1559 transactions.
    pub max_priority_fee_per_gas: Option<U256>,

    /// Min gas price to use for Legacy transactions, in wei.
    pub min_gas_price: Option<U256>,
    /// Min fee per gas to use for EIP-1559 transactions.
    pub min_fee_per_gas: Option<U256>,
    /// Min priority fee per gas to use for EIP-1559 transactions.
    pub min_priority_fee_per_gas: Option<U256>,

    /// Gas price multiplier denominator to use for transactions, eg 110
    pub gas_price_multiplier_denominator: Option<U256>,
    /// Gas price multiplier numerator to use for transactions, eg 100
    pub gas_price_multiplier_numerator: Option<U256>,
    /// Gas price cap multiplier to bound escalated prices by newly estimated prices.
    /// Default value is 3 if not specified.
    pub gas_price_cap_multiplier: Option<U256>,

    /// Gas price cap, in wei.
    pub gas_price_cap: Option<U256>,
    /// Gas limit cap, in wei.
    pub gas_limit_cap: Option<U256>,
}

/// Ethereum reorg period
#[derive(Copy, Clone, Debug)]
pub enum EthereumReorgPeriod {
    /// Number of blocks
    Blocks(u32),
    /// A block tag
    Tag(BlockId),
}

impl TryFrom<&ReorgPeriod> for EthereumReorgPeriod {
    type Error = ChainCommunicationError;

    fn try_from(value: &ReorgPeriod) -> Result<Self, Self::Error> {
        match value {
            ReorgPeriod::None => Ok(EthereumReorgPeriod::Blocks(0)),
            ReorgPeriod::Blocks(blocks) => Ok(EthereumReorgPeriod::Blocks(blocks.get())),
            ReorgPeriod::Tag(tag) => {
                let tag = match tag.as_str() {
                    "latest" => BlockNumber::Latest,
                    "finalized" => BlockNumber::Finalized,
                    "safe" => BlockNumber::Safe,
                    "earliest" => BlockNumber::Earliest,
                    "pending" => BlockNumber::Pending,
                    _ => return Err(ChainCommunicationError::InvalidReorgPeriod(value.clone())),
                };
                Ok(EthereumReorgPeriod::Tag(tag.into()))
            }
        }
    }
}

impl EthereumReorgPeriod {
    /// Converts the reorg period into a block id
    pub async fn into_block_id<M: Middleware + 'static>(
        &self,
        provider: &M,
    ) -> ChainResult<BlockId> {
        let block_id = match self {
            EthereumReorgPeriod::Blocks(_) => {
                (crate::get_finalized_block_number(provider, self).await? as u64).into()
            }
            // no need to fetch the block number for the `tag`
            EthereumReorgPeriod::Tag(tag) => *tag,
        };
        Ok(block_id)
    }
}

#[cfg(test)]
mod tests;
