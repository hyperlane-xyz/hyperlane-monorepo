use std::collections::HashMap;
use std::fmt::{Debug, Formatter};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use derive_builder::Builder;
use ethers::prelude::*;
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::utils::hex::ToHex;
use log::{debug, trace, warn};
use maplit::hashmap;
use prometheus::{CounterVec, GaugeVec, HistogramVec, IntCounterVec, IntGaugeVec};
use static_assertions::assert_impl_all;
use tokio::sync::RwLock;
use tokio::time::MissedTickBehavior;

pub use error::PrometheusMiddlewareError;

use crate::contracts::erc_20::Erc20;
use crate::{chain_name, u256_as_scaled_f64};

mod error;

/// Some basic information about a token.
#[derive(Clone, Debug)]
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
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
pub struct WalletInfo {
    /// A human-friendly name for the wallet. This should be a short string like
    /// "relayer".
    pub name: Option<String>,
}

/// Some basic information about a contract.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
pub struct ContractInfo {
    /// A human-friendly name for the contract. This should be a short string
    /// like "inbox".
    pub name: Option<String>,
    /// Mapping from function selectors to human readable names.
    pub functions: HashMap<Selector, String>,
}

/// Some basic information about a chain.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
pub struct ChainInfo {
    /// A human-friendly name for the chain. This should be a short string like
    /// "kovan".
    pub name: Option<String>,
}

/// Expected label names for the `block_height` metric.
pub const BLOCK_HEIGHT_LABELS: &[&str] = &["chain"];
/// Help string for the metric.
pub const BLOCK_HEIGHT_HELP: &str = "Tracks the current block height of the chain";

/// Expected label names for the `gas_price_gwei` metric.
pub const GAS_PRICE_GWEI_LABELS: &[&str] = &["chain"];
/// Help string for the metric.
pub const GAS_PRICE_GWEI_HELP: &str = "Tracks the current gas price of the chain";

/// Expected label names for the `contract_call_duration_seconds` metric.
pub const CONTRACT_CALL_DURATION_SECONDS_LABELS: &[&str] = &[
    "chain",
    "contract_name",
    "contract_address",
    "function_name",
    "function_selector",
];
/// Help string for the metric.
pub const CONTRACT_CALL_DURATION_SECONDS_HELP: &str =
    "Contract call durations by contract and function";

/// Expected label names for the `contract_call_count` metric.
pub const CONTRACT_CALL_COUNT_LABELS: &[&str] = &[
    "chain",
    "contract_name",
    "contract_address",
    "function_name",
    "function_selector",
];
/// Help string for the metric.
pub const CONTRACT_CALL_COUNT_HELP: &str = "Contract invocations by contract and function";

/// Expected label names for the `transaction_send_duration_seconds` metric.
pub const TRANSACTION_SEND_DURATION_SECONDS_LABELS: &[&str] = &["chain", "address_from"];
/// Help string for the metric.
pub const TRANSACTION_SEND_DURATION_SECONDS_HELP: &str =
    "Time taken to submit the transaction (not counting time for it to be included)";

/// Expected label names for the `transaction_send_total` metric.
pub const TRANSACTION_SEND_TOTAL_LABELS: &[&str] =
    &["chain", "address_from", "address_to", "txn_status"];
/// Help string for the metric.
pub const TRANSACTION_SEND_TOTAL_HELP: &str = "Number of transactions sent";

/// Expected label names for the `wallet_balance` metric.
pub const WALLET_BALANCE_LABELS: &[&str] = &[
    "chain",
    "wallet_address",
    "wallet_name",
    "token_address",
    "token_symbol",
    "token_name",
];
/// Help string for the metric.
pub const WALLET_BALANCE_HELP: &str = "Current balance of eth and other tokens in the `tokens` map for the wallet addresses in the `wallets` set";

/// Container for all the relevant middleware metrics.
#[derive(Clone, Builder)]
pub struct ProviderMetrics {
    /// Tracks the current block height of the chain.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain
    ///   the block number refers to.
    #[builder(setter(into, strip_option), default)]
    block_height: Option<IntGaugeVec>,

    /// Tracks the current gas price of the chain. Uses the base_fee_per_gas if
    /// available or else the median of the transactions.
    /// - `chain`: the chain name (or chain ID if the name is unknown) of the
    ///   chain the gas price refers to.
    #[builder(setter(into, strip_option), default)]
    gas_price_gwei: Option<GaugeVec>,

    /// Contract call durations by contract and function
    /// - `chain`: the chain name (or chain ID if the name is unknown) of the
    ///   chain the tx occurred on.
    /// - `contract_name`: contract name.
    /// - `contract_address`: contract address (hex).
    /// - `function_name`: contract function name.
    /// - `function_selector`: contract function hash (hex).
    #[builder(setter(into, strip_option), default)]
    contract_call_duration_seconds: Option<CounterVec>,

    /// Contract invocations by contract and function.
    /// - `chain`: the chain name (or chain ID if the name is unknown) of the
    ///   chain the tx occurred on.
    /// - `contract_name`: contract name.
    /// - `contract_address`: contract address (hex).
    /// - `function_name`: contract function name.
    /// - `function_selector`: contract function hash (hex).
    #[builder(setter(into, strip_option), default)]
    contract_call_count: Option<IntCounterVec>,

    /// Time taken to submit the transaction (not counting time for it to be
    /// included).
    /// - `chain`: the chain name (or chain ID if the name is unknown) of the
    ///   chain the tx occurred on.
    /// - `address_from`: source address of the transaction.
    #[builder(setter(into, strip_option), default)]
    transaction_send_duration_seconds: Option<HistogramVec>,

    /// Number of transactions sent.
    /// - `chain`: the chain name (or chain ID if the name is unknown) of the
    ///   chain the tx occurred on.
    /// - `address_from`: source address of the transaction.
    /// - `address_to`: destination address of the transaction.
    #[builder(setter(into, strip_option), default)]
    transaction_send_total: Option<IntCounterVec>,

    // /// Gas spent on completed transactions.
    // /// - `chain`: the chain name (or ID if the name is unknown) of the chain the tx occurred
    // on. /// - `address_from`: source address of the transaction.
    // /// - `address_to`: destination address of the transaction.
    // #[builder(setter(into, strip_option), default)]
    // transaction_send_gas_eth_total: Option<CounterVec>,
    /// Current balance of eth and other tokens in the `tokens` map for the
    /// wallet addresses in the `wallets` set.
    /// - `chain`: the chain name (or chain ID if the name is unknown) of the
    ///   chain the tx occurred on.
    /// - `wallet_address`: Address of the wallet holding the funds.
    /// - `wallet_name`: Name of the address holding the funds.
    /// - `token_address`: Address of the token.
    /// - `token_symbol`: Symbol of the token.
    /// - `token_name`: Full name of the token.
    #[builder(setter(into, strip_option), default)]
    wallet_balance: Option<GaugeVec>,
}

/// An ethers-rs middleware that instruments calls with prometheus metrics. To
/// make this is flexible as possible, the metric vecs need to be created and
/// named externally, they should follow the naming convention here and must
/// include the described labels.
pub struct PrometheusMiddleware<M> {
    inner: Arc<M>,
    metrics: ProviderMetrics,
    conf: Arc<RwLock<PrometheusMiddlewareConf>>,
}

/// Configuration for the prometheus middleware. This can be loaded via serde.
#[derive(Default, Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
pub struct PrometheusMiddlewareConf {
    /// The tokens to track and identifying info
    #[cfg_attr(feature = "serde", serde(default))]
    pub tokens: HashMap<Address, TokenInfo>,

    /// The wallets to track and identifying info
    #[cfg_attr(feature = "serde", serde(default))]
    pub wallets: HashMap<Address, WalletInfo>,

    /// Contract info for more useful metrics
    #[cfg_attr(feature = "serde", serde(default))]
    pub contracts: HashMap<Address, ContractInfo>,

    /// Information about the chain this provider is for.
    pub chain: Option<ChainInfo>,
}

assert_impl_all!(PrometheusMiddlewareConf: Send, Sync);
assert_impl_all!(tokio::sync::RwLockReadGuard<PrometheusMiddlewareConf>: Send);

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

        let chain = {
            let data = self.conf.read().await;
            chain_name(&data.chain).to_owned()
        };
        let addr_from: String = tx
            .from()
            .map(|v| v.encode_hex())
            .unwrap_or_else(|| "none".into());
        let addr_to = tx
            .to()
            .map(|v| match v {
                NameOrAddress::Name(v) => v.clone(),
                NameOrAddress::Address(v) => v.encode_hex(),
            })
            .unwrap_or_else(|| "none".into());

        if let Some(m) = &self.metrics.transaction_send_total {
            m.with(&hashmap! {
                "chain" => chain.as_str(),
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
                "chain" => chain.as_str(),
                "address_from" => addr_from.as_str(),
            })
            .observe(duration);
        }
        if let Some(m) = &self.metrics.transaction_send_total {
            m.with(&hashmap! {
                "chain" => chain.as_str(),
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

        if self.metrics.contract_call_duration_seconds.is_some()
            || self.metrics.contract_call_count.is_some()
        {
            let data = self.conf.read().await;
            let chain = chain_name(&data.chain);
            let empty_hm = HashMap::default();
            let (contract_addr, contract_name, contract_fns) = tx
                .to()
                .and_then(|addr| match addr {
                    NameOrAddress::Name(n) => {
                        // not supporting ENS names for lookups by address right now
                        Some((n.clone(), n.clone(), &empty_hm))
                    }
                    NameOrAddress::Address(a) => data
                        .contracts
                        .get(a)
                        .map(|c| (c.name.as_deref().unwrap_or("unknown"), &c.functions))
                        .map(|(n, m)| (a.encode_hex(), n.into(), m)),
                })
                .unwrap_or_else(|| ("".into(), "unknown".into(), &empty_hm));

            let fn_selector: Option<Selector> = tx
                .data()
                .filter(|data| data.0.len() >= 4)
                .map(|data| [data.0[0], data.0[1], data.0[2], data.0[3]]);
            let fn_name: &str = fn_selector
                .and_then(|s| contract_fns.get(&s))
                .map(|s| s.as_str())
                .unwrap_or("unknown");
            let fn_selector: String = fn_selector
                .map(|s| format!("{:02x}{:02x}{:02x}{:02x}", s[0], s[1], s[2], s[3]))
                .unwrap_or_else(|| "unknown".into());

            let labels = hashmap! {
                "chain" => chain,
                "contract_name" => contract_name.as_str(),
                "contract_address" => contract_addr.as_str(),
                "function_name" => fn_name,
                "function_selector" => &fn_selector,
            };
            if let Some(m) = &self.metrics.contract_call_count {
                m.with(&labels).inc();
            }
            if let Some(m) = &self.metrics.contract_call_duration_seconds {
                m.with(&labels)
                    .inc_by((Instant::now() - start).as_secs_f64());
            }
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
            conf: Arc::new(RwLock::new(conf)),
        }
    }

    /// Start tracking metrics for a new token.
    pub async fn track_new_token(&self, addr: Address, info: TokenInfo) {
        self.track_new_tokens([(addr, info)]).await;
    }

    /// Start tacking metrics for new tokens.
    pub async fn track_new_tokens(&self, iter: impl IntoIterator<Item = (Address, TokenInfo)>) {
        let mut data = self.conf.write().await;
        for (addr, info) in iter {
            data.tokens.insert(addr, info);
        }
    }

    /// Start tracking metrics for a new wallet.
    pub async fn track_new_wallet(&self, addr: Address, info: WalletInfo) {
        self.track_new_wallets([(addr, info)]).await;
    }

    /// Start tracking metrics for new wallets.
    pub async fn track_new_wallets(&self, iter: impl IntoIterator<Item = (Address, WalletInfo)>) {
        let mut data = self.conf.write().await;
        for (addr, info) in iter {
            data.wallets.insert(addr, info);
        }
    }
}

impl<M: Middleware> PrometheusMiddleware<M> {
    /// Start the update cycle using tokio. This must be called if you want
    /// some metrics to be updated automatically. Alternatively you could call
    /// update yourself.
    pub fn start_updating_on_interval(
        self: &Arc<Self>,
        period: Duration,
    ) -> impl Future<Output = ()> + Send {
        let zelf = Arc::downgrade(self);

        async move {
            let mut interval = tokio::time::interval(period);
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                if let Some(zelf) = zelf.upgrade() {
                    zelf.update().await;
                } else {
                    return;
                }
                interval.tick().await;
            }
        }
    }
}

impl<M: Middleware + Send + Sync> PrometheusMiddleware<M> {
    /// Update gauges. You should submit this on a schedule to your runtime to
    /// be collected once on a regular interval that ideally aligns with the
    /// prometheus scrape interval.
    pub fn update(&self) -> impl Future<Output = ()> {
        // all metrics are Arcs internally so just clone the ones we want to report for.
        let wallet_balance = self.metrics.wallet_balance.clone();
        let block_height = self.metrics.block_height.clone();
        let gas_price_gwei = self.metrics.gas_price_gwei.clone();

        let data_ref = self.conf.clone();
        let client = self.inner.clone();

        async move {
            let data = data_ref.read().await;
            let chain = chain_name(&data.chain);
            debug!("Updating metrics for chain ({chain})");

            if block_height.is_some() || gas_price_gwei.is_some() {
                Self::update_block_details(&*client, chain, block_height, gas_price_gwei).await;
            }
            if let Some(wallet_balance) = wallet_balance {
                Self::update_wallet_balances(client.clone(), &*data, chain, wallet_balance).await;
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
            if let Some(london_fee) = current_block.base_fee_per_gas {
                let gas = u256_as_scaled_f64(london_fee, 18) * 1e9;
                trace!("Gas price for chain {chain} is {gas:.1}gwei");
                gas_price_gwei.with(&hashmap! { "chain" => chain }).set(gas);
            } else {
                trace!("Gas price for chain {chain} unknown, chain is pre-london");
            }
        }
    }

    async fn update_wallet_balances(
        client: Arc<M>,
        data: &PrometheusMiddlewareConf,
        chain: &str,
        wallet_balance_metric: GaugeVec,
    ) {
        for (wallet_addr, wallet_info) in data.wallets.iter() {
            let wallet_addr_str: String = wallet_addr.encode_hex();
            let wallet_name = wallet_info.name.as_deref().unwrap_or("none");

            match client.get_balance(*wallet_addr, None).await {
                Ok(balance) => {
                    // Okay, so the native type is not a token, but whatever, close enough.
                    // Note: This is ETH for many chains, but not all so that is why we use `N` and `Native`
                    // TODO: can we get away with scaling as 18 in all cases here? I am guessing not.
                    let balance = u256_as_scaled_f64(balance, 18);
                    trace!("Wallet {wallet_name} ({wallet_addr_str}) on chain {chain} balance is {balance} of the native currency");
                    wallet_balance_metric
                        .with(&hashmap! {
                        "chain" => chain,
                        "wallet_address" => wallet_addr_str.as_str(),
                        "wallet_name" => wallet_name,
                        "token_address" => "none",
                        "token_symbol" => "Native",
                        "token_name" => "Native"
                    }).set(balance)
                },
                Err(e) => warn!("Metric update failed for wallet {wallet_name} ({wallet_addr_str}) on chain {chain} balance for native currency; {e}")
            }
            for (token_addr, token) in data.tokens.iter() {
                let token_addr_str: String = token_addr.encode_hex();
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
