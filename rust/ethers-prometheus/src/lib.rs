//! A prometheus middleware to collect metrics.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::collections::{HashMap, HashSet};
use std::fmt::{Debug, Formatter};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use derive_builder::Builder;
use ethers::prelude::*;
use ethers::types::transaction::eip2718::TypedTransaction;
use parking_lot::{RawRwLock, RwLock};
use parking_lot::lock_api::RwLockReadGuard;
use prometheus::{CounterVec, GaugeVec, HistogramVec, IntCounterVec};
pub use error::PrometheusMiddlewareError;
use maplit::hashmap;

mod erc20;
mod error;

/// Convert a u256 scaled integer value into the corresponding f64 value.
const fn u256_as_scaled_f64(value: U256, decimals: u8) -> f64 {
    ((value.0[0] as f64)
        + (value.0[1] as f64) * (2u64.pow(64) as f64)
        + (value.0[2] as f64) * (2u64.pow(128) as f64)
        + (value.0[3] as f64) * (2u64.pow(192) as f64))
        / 10u64.pow(decimals as u32) as f64
}

/// Some basic information about a token.
pub struct TokenInfo {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
}

pub struct WalletInfo {
    pub name: Option<String>,
}

#[derive(Clone, Builder)]
pub struct Metrics {
    /// Contract call durations by contract and function.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain the tx occurred on.
    /// - `contract`: contract address.
    /// - `contract_name`: contract name.
    /// - `contract_function`: address of the contract function.
    /// - `contract_function_name`: name of the contract function being called.
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

    pub fn track_new_token(&self, addr: Address, info: TokenInfo) {
        self.track_new_tokens([(addr, info)]);
    }

    pub fn track_new_tokens(&self, iter: impl IntoIterator<Item = (Address, TokenInfo)>) {
        let mut data = self.data.write();
        for (addr, info) in iter {
            data.tokens.insert(addr, info);
        }
    }

    pub fn track_new_wallet(&self, addr: Address, info: WalletInfo) {
        self.track_new_wallets([(addr, info)])
    }

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
        let data_ref = self.data.clone();
        let inner = self.inner.clone();

        async move {
            let data = data_ref.read();
            if let Some(wallet_balance) = wallet_balance {
                Self::update_wallet_balances(inner, &*data, wallet_balance).await;
            }

            // more metrics to come...
        }
    }

    async fn update_wallet_balances(inner: Arc<M>, data: &InnerData, wallet_balance_metric: GaugeVec) {
        let chain = metrics_chain_name(inner.get_chainid().await.map(|id| id.as_u64()).ok());
        for (wallet_addr, wallet_info) in data.wallets.iter() {
            let wallet_addr_str = wallet_addr.to_string();
            let wallet_name = wallet_info.name.as_deref().unwrap_or("none");
            if let Ok(balance) = inner.get_balance(*wallet_addr, None).await {
                // Okay, so Ether is not a token, but whatever, close enough.
                wallet_balance_metric
                    .with(&hashmap! {
                                "chain" => chain.as_str(),
                                "wallet_address" => wallet_addr_str.as_str(),
                                "wallet_name" => wallet_name,
                                "token_address" => "none",
                                "token_symbol" => "ETH",
                                "token_name" => "Ether"
                            })
                    .set(u256_as_scaled_f64(balance, 18))
            }
            for (token_addr, token_data) in data.tokens.iter() {

            }
        }
    }
}

impl<M: Middleware> Debug for PrometheusMiddleware<M> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        todo!()
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

pub fn metrics_address(addr: Option<Address>) -> String {
    if let Some(addr) = addr {
        // TODO: does this format as Hex?
        format!("{addr}")
    } else {
        "none".into()
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
