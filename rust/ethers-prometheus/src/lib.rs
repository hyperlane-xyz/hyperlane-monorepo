//! A prometheus middleware to collect metrics.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::collections::HashMap;
use std::fmt::{Debug, Formatter};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use derive_builder::Builder;
use ethers::prelude::*;
use ethers::types::transaction::eip2718::TypedTransaction;
use log::{debug, trace, warn};
use maplit::hashmap;
use parking_lot::RwLock;
use prometheus::{CounterVec, GaugeVec, HistogramVec, IntCounterVec, IntGaugeVec};

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
pub struct TokenInfo {
    pub name: String,
    pub symbol: String,
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

pub struct WalletInfo {
    pub name: Option<String>,
}

pub const BLOCK_HEIGHT_LABELS: &[&str] = &["chain"];
pub const GAS_PRICE_GWEI_LABELS: &[&str] = &["chain"];
pub const CONTRACT_CALL_DURATION_SECONDS_LABELS: &[&str] = &[
    "chain",
    "contract_name",
    "contract_address",
    "contract_function_name",
    "contract_function_address",
];
pub const CONTRACT_SEND_DURATION_SECONDS_LABELS: &[&str] = &["chain", "address_from"];
pub const TRANSACTION_SEND_DURATION_SECONDS_LABELS: &[&str] = &["chain", "address_from"];
pub const TRANSACTION_SEND_TOTAL_LABELS: &[&str] =
    &["chain", "address_from", "address_to", "txn_status"];
pub const TRANSACTION_SEND_ETH_TOTAL_LABELS: &[&str] =
    &["chain", "address_from", "address_to", "txn_status"];
pub const TRANSACTION_SEND_GAS_ETH_TOTAL_LABELS: &[&str] = &["chain", "address_from", "address_to"];
pub const WALLET_BALANCE_LABELS: &[&str] = &[
    "chain",
    "wallet_address",
    "wallet_name",
    "token_address",
    "token_name",
    "token_symbol",
    "token_name",
];

#[derive(Clone, Builder)]
pub struct Metrics {
    /// Tracks the current block height of the chain.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the block number refers to.
    block_height: Option<IntGaugeVec>,

    /// Tracks the current gas price of the chain. Uses the base_fee_per_gas if available or else
    /// the median of the transactions.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the gas price refers to.
    gas_price_gwei: Option<GaugeVec>,

    /// Contract call durations by contract and function.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the tx occurred on.
    /// - `contract_name`: contract name.
    /// - `contract_address`: contract address.
    /// - `contract_function_name`: name of the contract function being called.
    /// - `contract_function_address`: address of the contract function.
    contract_call_duration_seconds: Option<HistogramVec>,

    /// Time taken to complete transactions.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the tx occurred on.
    /// - `address_from`: source address of the transaction.
    transaction_send_duration_seconds: Option<HistogramVec>,

    /// Number of transactions sent.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the tx occurred on.
    /// - `address_from`: source address of the transaction.
    /// - `address_to`: destination address of the transaction.
    /// - `txn_status`: one of `dispatched`, `completed`, or `failed`.
    #[builder(setter(into, strip_option), default)]
    transaction_send_total: Option<IntCounterVec>,

    // TODO: support ERC20 send amounts
    /// Value of ethereum sent by transactions.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the tx occurred on.
    /// - `address_from`: source address of the transaction.
    /// - `address_to`: destination address of the transaction.
    /// - `txn_status`: one of `dispatched`, `completed`, or `failed`.
    #[builder(setter(into, strip_option), default)]
    transaction_send_eth_total: Option<CounterVec>,

    /// Gas spent on completed transactions.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the tx occurred on.
    /// - `address_from`: source address of the transaction.
    /// - `address_to`: destination address of the transaction.
    #[builder(setter(into, strip_option), default)]
    transaction_send_gas_eth_total: Option<CounterVec>,

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

struct InnerData {
    tokens: HashMap<Address, TokenInfo>,
    wallets: HashMap<Address, WalletInfo>,
}

/// An ethers-rs middleware that inturments calls with prometheus metrics. To make this is flexible
/// as possible, the metric vecs need to be created and named externally, they should follow the
/// naming convention here and must include the described labels.
pub struct PrometheusMiddleware<M> {
    inner: Arc<M>,
    metrics: Metrics,
    data: Arc<RwLock<InnerData>>,
    // /// Allow looking up data for metrics recording by making contract calls. Results will be cached
    // /// to prevent unnecessary lookups.
    // allow_contract_calls: bool,
}

impl<M> PrometheusMiddleware<M> {
    /// Create a new prometheus middleware instance.
    /// - `inner`: The wrapped middleware.
    /// - `metrics`: Metrics objects we will report to.
    /// - `tokens`: Tokens to watch the balances of.
    /// - `wallets`: Wallets to watch the balances of.
    pub fn new(
        inner: M,
        metrics: Metrics,
        tokens: HashMap<Address, TokenInfo>,
        wallets: HashMap<Address, WalletInfo>,
    ) -> Self {
        Self {
            inner: Arc::new(inner),
            metrics,
            data: Arc::new(RwLock::new(InnerData { tokens, wallets })),
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
    pub fn update(&self, interval: Duration) -> impl Future<Output = ()> {
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
        data: &InnerData,
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
        let tx: TypedTransaction = tx.into();
        let chain_name = metrics_chain_name(tx.chain_id().map(|id| id.as_u64()));
        let addr_from = tx
            .from()
            .map(|v| v.to_string())
            .unwrap_or_else(|| "none".into());

        // self.transaction_dispatched();
        Ok(self.inner.send_transaction(tx, block).await?)
    }

    async fn call(
        &self,
        tx: &TypedTransaction,
        block: Option<BlockId>,
    ) -> Result<Bytes, Self::Error> {
        todo!()
    }
}
