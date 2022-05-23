//! A prometheus middleware to collect metrics.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::collections::HashMap;
use std::fmt::{Debug, Formatter};
use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use derive_builder::Builder;
use ethers::prelude::*;
use ethers::types::transaction::eip2718::TypedTransaction;
use log::{debug, trace, warn};
use maplit::hashmap;
use parking_lot::RwLock;
use prometheus::{GaugeVec, HistogramVec, IntCounterVec, IntGaugeVec};

use erc20::Erc20;
pub use error::PrometheusMiddlewareError;

mod erc20;
mod error;

/// Convert a u256 scaled integer value into the corresponding f64 value.
fn u256_as_scaled_f64(value: U256, decimals: u8) -> f64 {
    ((value.0[0] as f64)
        + (value.0[1] as f64) * (2u64.pow(64) as f64)
        + (value.0[2] as f64) * (2u64.pow(128) as f64)
        + (value.0[3] as f64) * (2u64.pow(192) as f64))
        / (10u64.pow(decimals as u32) as f64)
}

/// Some basic information about a token.
#[derive(Clone)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
pub struct TokenInfo {
    /// Full name of the token. E.g. Ether.
    pub name: String,
    /// Token symbol. E.g. ETH.
    pub symbol: String,
    /// Number of
    pub decimals: u8,
}

impl Default for TokenInfo {
    fn default() -> Self {
        Self {
            name: "Unknown".into(),
            symbol: "".into(),
            decimals: 18,
        }
    }
}

/// Some basic information about a wallet.
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
pub struct WalletInfo {
    /// A human-friendly name for the wallet. This should be a short string like "relayer".
    pub name: Option<String>,
}

/// Some basic information about a contract.
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
pub struct ContractInfo {
    /// A human-friendly name for the contract. This should be a short string like "inbox".
    pub name: Option<String>,
}

/// Expected label names for the `block_height` metric.
pub const BLOCK_HEIGHT_LABELS: &[&str] = &["chain"];
/// Help string for the metric.
pub const BLOCK_HEIGHT_HELP: &str = "Tracks the current block height of the chain";

/// Expected label names for the `gas_price_gwei` metric.
pub const GAS_PRICE_GWEI_LABELS: &[&str] = &["chain"];
/// Help string for the metric.
pub const GAS_PRICE_GEWI_HELP: &str = "Tracks the current gas price of the chain";

/// Expected label names for the `contract_call_duration_seconds` metric.
pub const CONTRACT_CALL_DURATION_SECONDS_LABELS: &[&str] =
    &["chain", "contract_name", "contract_address"];
/// Help string for the metric.
pub const CONTRACT_CALL_DURATION_SECONDS_HELP: &str = "Contract call durations by contract";

/// Expected label names for the `transaction_send_duration_seconds` metric.
pub const TRANSACTION_SEND_DURATION_SECONDS_LABELS: &[&str] = &["chain", "address_from"];
/// Help string for the metric.
pub const TRANSACTION_SEND_DURATION_SECONDS_HELP: &str =
    "Time taken to submit the transaction (not counting time for it to be included)";

/// Expected label names for the `transaction_send_total` metric.
pub const TRANSACTION_SEND_TOTAL_LABELS: &[&str] = &["chain", "address_from", "address_to"];
/// Help string for the metric.
pub const TRANSACTION_SEND_TOTAL_HELP: &str = "Number of transactions sent";

/// Expected label names for the `wallet_balance` metric.
pub const WALLET_BALANCE_LABELS: &[&str] = &[
    "chain",
    "wallet_address",
    "wallet_name",
    "token_address",
    "token_name",
    "token_symbol",
    "token_name",
];
/// Help string for the metric.
pub const WALLET_BALANCE_HELP: &str = "Current balance of eth and other tokens in the `tokens` map for the wallet addresses in the `wallets` set";

/// Container for all the relevant middleware metrics
#[derive(Clone, Builder)]
pub struct ProviderMetrics {
    /// Tracks the current block height of the chain.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the block number refers to.
    #[builder(setter(into, strip_option), default)]
    block_height: Option<IntGaugeVec>,

    /// Tracks the current gas price of the chain. Uses the base_fee_per_gas if available or else
    /// the median of the transactions.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the gas price refers to.
    #[builder(setter(into, strip_option), default)]
    gas_price_gwei: Option<GaugeVec>,

    /// Contract call durations by contract.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the tx occurred on.
    /// - `contract_name`: contract name.
    /// - `contract_address`: contract address.
    #[builder(setter(into, strip_option), default)]
    contract_call_duration_seconds: Option<HistogramVec>,

    /// Time taken to submit the transaction (not counting time for it to be included).
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the tx occurred on.
    /// - `address_from`: source address of the transaction.
    #[builder(setter(into, strip_option), default)]
    transaction_send_duration_seconds: Option<HistogramVec>,

    /// Number of transactions sent.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the tx occurred on.
    /// - `address_from`: source address of the transaction.
    /// - `address_to`: destination address of the transaction.
    #[builder(setter(into, strip_option), default)]
    transaction_send_total: Option<IntCounterVec>,

    // /// Gas spent on completed transactions.
    // /// - `chain`: the chain name (or ID if the name is unknown) of the chain the tx occurred on.
    // /// - `address_from`: source address of the transaction.
    // /// - `address_to`: destination address of the transaction.
    // #[builder(setter(into, strip_option), default)]
    // transaction_send_gas_eth_total: Option<CounterVec>,
    /// Current balance of eth and other tokens in the `tokens` map for the wallet addresses in the
    /// `wallets` set.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the tx occurred on.
    /// - `wallet_address`: Address of the wallet holding the funds.
    /// - `wallet_name`: Name of the address holding the funds.
    /// - `token_address`: Address of the token.
    /// - `token_symbol`: Symbol of the token.
    /// - `token_name`: Full name of the token.
    #[builder(setter(into, strip_option), default)]
    wallet_balance: Option<GaugeVec>,
}

/// An ethers-rs middleware that instruments calls with prometheus metrics. To make this is flexible
/// as possible, the metric vecs need to be created and named externally, they should follow the
/// naming convention here and must include the described labels.
pub struct PrometheusMiddleware<M> {
    inner: Arc<M>,
    metrics: ProviderMetrics,
    data: Arc<RwLock<PrometheusMiddlewareConf>>,
    // /// Allow looking up data for metrics recording by making contract calls. Results will be cached
    // /// to prevent unnecessary lookups.
    // allow_contract_calls: bool,
}

/// Configuration for the prometheus middleware. This can be loaded via serde.
#[derive(Default)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
pub struct PrometheusMiddlewareConf {
    /// The tokens to track and identifying info
    pub tokens: HashMap<Address, TokenInfo>,
    /// The wallets to track and identifying info
    pub wallets: HashMap<Address, WalletInfo>,
    /// Contract info for more useful metrics
    pub contracts: HashMap<Address, ContractInfo>,
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl<M: Middleware> Middleware for PrometheusMiddleware<M> {
    type Error = PrometheusMiddlewareError<M::Error>;
    type Provider = M::Provider;
    type Inner = M;

    fn inner(&self) -> &Self::Inner {
        &self.inner
    }

    async fn send_transaction<T: Into<TypedTransaction> + Send + Sync>(
        &self,
        tx: T,
        block: Option<BlockId>,
    ) -> Result<PendingTransaction<'_, Self::Provider>, Self::Error> {
        let start = Instant::now();
        let tx: TypedTransaction = tx.into();

        let chain_name = metrics_chain_name(tx.chain_id().map(|id| id.as_u64()));
        let addr_from = tx
            .from()
            .map(|v| v.to_string())
            .unwrap_or_else(|| "none".into());
        let addr_to = tx
            .to()
            .map(|v| match v {
                NameOrAddress::Name(v) => v.clone(),
                NameOrAddress::Address(v) => v.to_string(),
            })
            .unwrap_or_else(|| "none".into());

        if let Some(m) = &self.metrics.transaction_send_total {
            m.with(&hashmap! {
                "chain" => chain_name.as_str(),
                "address_from" => addr_from.as_str(),
                "address_to" => addr_to.as_str(),
                "txn_status" => "dispatched"
            })
            .inc()
        }

        let result = self.inner.send_transaction(tx, block).await;

        if let Some(m) = &self.metrics.transaction_send_duration_seconds {
            let duration = (Instant::now() - start).as_secs_f64();
            m.with(&hashmap! {
                "chain" => chain_name.as_str(),
                "address_from" => addr_from.as_str(),
            })
            .observe(duration);
        }
        if let Some(m) = &self.metrics.transaction_send_total {
            m.with(&hashmap! {
                "chain" => chain_name.as_str(),
                "address_from" => addr_from.as_str(),
                "address_to" => addr_to.as_str(),
                "txn_status" => if result.is_ok() { "completed" } else { "failed" }
            })
            .inc()
        }

        Ok(result?)
    }

    async fn call(
        &self,
        tx: &TypedTransaction,
        block: Option<BlockId>,
    ) -> Result<Bytes, Self::Error> {
        let start = Instant::now();
        let result = self.inner.call(tx, block).await;

        if let Some(m) = &self.metrics.contract_call_duration_seconds {
            let data = self.data.read();
            let chain_name = metrics_chain_name(tx.chain_id().map(|id| id.as_u64()));
            let (contract_addr, contract_name) = tx
                .to()
                .and_then(|addr| match addr {
                    NameOrAddress::Name(n) => Some((n.clone(), n.clone())),
                    NameOrAddress::Address(a) => data
                        .contracts
                        .get(a)
                        .and_then(|c| c.name.clone())
                        .map(|n| (a.to_string(), n)),
                })
                .unwrap_or_else(|| ("".into(), "unknown".into()));

            m.with(&hashmap! {
                "chain" => chain_name.as_str(),
                "contract_name" => contract_name.as_str(),
                "contract_address" => contract_addr.as_str()
            })
            .observe((Instant::now() - start).as_secs_f64())
        }

        Ok(result?)
    }
}

impl<M> PrometheusMiddleware<M> {
    /// Create a new prometheus middleware instance.
    /// - `inner`: The wrapped middleware.
    /// - `metrics`: Metrics objects we will report to.
    /// - `tokens`: Tokens to watch the balances of.
    /// - `wallets`: Wallets to watch the balances of.
    pub fn new(inner: M, metrics: ProviderMetrics, conf: PrometheusMiddlewareConf) -> Self {
        Self {
            inner: Arc::new(inner),
            metrics,
            data: Arc::new(RwLock::new(conf)),
        }
    }

    /// Start tracking metrics for a new token.
    pub fn track_new_token(&self, addr: Address, info: TokenInfo) {
        self.track_new_tokens([(addr, info)]);
    }

    /// Start tacking metrics for new tokens.
    pub fn track_new_tokens(&self, iter: impl IntoIterator<Item = (Address, TokenInfo)>) {
        let mut data = self.data.write();
        for (addr, info) in iter {
            data.tokens.insert(addr, info);
        }
    }

    /// Start tracking metrics for a new wallet.
    pub fn track_new_wallet(&self, addr: Address, info: WalletInfo) {
        self.track_new_wallets([(addr, info)])
    }

    /// Start tracking metrics for new wallets.
    pub fn track_new_wallets(&self, iter: impl IntoIterator<Item = (Address, WalletInfo)>) {
        let mut data = self.data.write();
        for (addr, info) in iter {
            data.wallets.insert(addr, info);
        }
    }
}

impl<M: Middleware> PrometheusMiddleware<M> {
    /// Update gauges. You should submit this on a schedule to your runtime to be collected once
    /// on a regular interval that ideally aligns with the prometheus scrape interval.
    pub fn update(&self) -> impl Future<Output = ()> {
        // all metrics are Arcs internally so just clone the ones we want to report for.
        let wallet_balance = self.metrics.wallet_balance.clone();
        let block_height = self.metrics.block_height.clone();
        let gas_price_gwei = self.metrics.gas_price_gwei.clone();

        let data_ref = self.data.clone();
        let client = self.inner.clone();

        async move {
            let data = data_ref.read();
            let chain = metrics_chain_name(client.get_chainid().await.map(|id| id.as_u64()).ok());
            debug!("Updating metrics for chain ({chain})");

            if block_height.is_some() || gas_price_gwei.is_some() {
                Self::update_block_details(&*client, &chain, block_height, gas_price_gwei).await;
            }
            if let Some(wallet_balance) = wallet_balance {
                Self::update_wallet_balances(client.clone(), &*data, &chain, wallet_balance).await;
            }

            // more metrics to come...
        }
    }

    async fn update_block_details(
        client: &M,
        chain: &str,
        block_height: Option<IntGaugeVec>,
        gas_price_gwei: Option<GaugeVec>,
    ) {
        let current_block = if let Ok(Some(b)) = client.get_block(BlockNumber::Latest).await {
            b
        } else {
            return;
        };

        if let Some(block_height) = block_height {
            let height = current_block
                .number
                .expect("Block number should always be Some for included blocks.")
                .as_u64() as i64;
            trace!("Block height for chain {chain} is {height}");
            block_height
                .with(&hashmap! { "chain" => chain })
                .set(height);
        }
        if let Some(gas_price_gwei) = gas_price_gwei {
            let gas = if let Some(london_fee) = current_block.base_fee_per_gas {
                u256_as_scaled_f64(london_fee, 18) * 1e9
            } else {
                todo!("Pre-london gas calculation is not currently supported.")
            };
            trace!("Gas price for chain {chain} is {gas:.1}gwei");
            gas_price_gwei.with(&hashmap! { "chain" => chain }).set(gas);
        }
    }

    async fn update_wallet_balances(
        client: Arc<M>,
        data: &PrometheusMiddlewareConf,
        chain: &str,
        wallet_balance_metric: GaugeVec,
    ) {
        for (wallet_addr, wallet_info) in data.wallets.iter() {
            let wallet_addr_str = wallet_addr.to_string();
            let wallet_name = wallet_info.name.as_deref().unwrap_or("none");

            match client.get_balance(*wallet_addr, None).await {
                Ok(balance) => {
                    // Okay, so Ether is not a token, but whatever, close enough.
                    let balance = u256_as_scaled_f64(balance, 18);
                    trace!("Wallet {wallet_name} ({wallet_addr_str}) on chain {chain} balance is {balance}ETH");
                    wallet_balance_metric
                        .with(&hashmap! {
                        "chain" => chain,
                        "wallet_address" => wallet_addr_str.as_str(),
                        "wallet_name" => wallet_name,
                        "token_address" => "none",
                        "token_symbol" => "ETH",
                        "token_name" => "Ether"
                    }).set(balance)
                },
                Err(e) => warn!("Metric update failed for wallet {wallet_name} ({wallet_addr_str}) on chain {chain} balance for Ether; {e}")
            }
            for (token_addr, token) in data.tokens.iter() {
                let token_addr_str = token_addr.to_string();
                let balance = match Erc20::new(*token_addr, client.clone())
                    .balance_of(*wallet_addr)
                    .call()
                    .await
                {
                    Ok(b) => u256_as_scaled_f64(b, token.decimals),
                    Err(e) => {
                        warn!("Metric update failed for wallet {wallet_name} ({wallet_addr_str}) on chain {chain} balance for {name}; {e}", name=token.name);
                        continue;
                    }
                };
                trace!("Wallet {wallet_name} ({wallet_addr_str}) on chain {chain} balance is {balance}{}", token.symbol);
                wallet_balance_metric
                    .with(&hashmap! {
                        "chain" => chain,
                        "wallet_address" => wallet_addr_str.as_str(),
                        "wallet_name" => wallet_name,
                        "token_address" => token_addr_str.as_str(),
                        "token_symbol" => token.symbol.as_str(),
                        "token_name" => token.symbol.as_str()
                    })
                    .set(balance);
            }
        }
    }
}

impl<M: Middleware> Debug for PrometheusMiddleware<M> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "PrometheusMiddleware({:?})", self.inner)
    }
}

/// Get the metrics appropriate chain name from the chain ID.
pub fn metrics_chain_name(chain_id: Option<u64>) -> String {
    if let Some(chain_id) = chain_id {
        if let Ok(chain) = Chain::try_from(chain_id) {
            format!("{chain}")
        } else {
            format!("{chain_id}")
        }
    } else {
        "unknown".into()
    }
}
