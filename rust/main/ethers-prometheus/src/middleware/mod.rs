//! A middleware layer which collects metrics about operations made with a
//! provider.

use std::clone::Clone;
use std::collections::HashMap;
use std::fmt::{Debug, Formatter};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use derive_builder::Builder;
use ethers::abi::AbiEncode;
use ethers::prelude::*;
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::utils::hex::ToHex;
use hyperlane_metric::prometheus_metric::ChainInfo;
use maplit::hashmap;
use prometheus::{CounterVec, IntCounterVec};
use static_assertions::assert_impl_all;
use tokio::sync::RwLock;

pub use error::PrometheusMiddlewareError;

mod error;

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
    /// like "mailbox".
    pub name: Option<String>,
    /// Mapping from function selectors to human readable names.
    pub functions: HashMap<Selector, String>,
}

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

/// Expected label names for the `log_query_duration_seconds` metric.
pub const LOGS_QUERY_DURATION_SECONDS_LABELS: &[&str] = &[
    "chain",
    "contract_name",
    "address",
    "topic0",
    "topic1",
    "topic2",
    "topic3",
];

/// Help string for the metric.
pub const LOGS_QUERY_DURATION_SECONDS_HELP: &str = "Log query durations by address and topic.";

/// Expected label names for the `log_query_count` metric.
pub const LOGS_QUERY_COUNT_LABELS: &[&str] = &[
    "chain",
    "contract_name",
    "address",
    "topic0",
    "topic1",
    "topic2",
    "topic3",
];

/// Help string for the metric.
pub const LOG_QUERY_COUNT_HELP: &str = "Discrete number of log queries by address and topic.";

/// Expected label names for the `transaction_send_duration_seconds` metric.
pub const TRANSACTION_SEND_DURATION_SECONDS_LABELS: &[&str] =
    &["chain", "address_from", "address_to", "txn_status"];
/// Help string for the metric.
pub const TRANSACTION_SEND_DURATION_SECONDS_HELP: &str =
    "Time taken to submit the transaction (not counting time for it to be included)";

/// Expected label names for the `transaction_send_total` metric.
pub const TRANSACTION_SEND_TOTAL_LABELS: &[&str] =
    &["chain", "address_from", "address_to", "txn_status"];
/// Help string for the metric.
pub const TRANSACTION_SEND_TOTAL_HELP: &str = "Number of transactions sent";

/// Container for all the relevant middleware metrics.
#[derive(Clone, Builder)]
pub struct MiddlewareMetrics {
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

    /// Log query durations by address and topic.
    /// - `chain`: the chain name (or chain ID if the name is unknown) of the
    ///   chain the logs were queried on.
    /// - `contract_name`: name of the address if it is a known contract.
    /// - `address`: address being filtered for log events (hex).
    /// - `topic0`: topic 0 being filtered for; empty if not specified (hex).
    /// - `topic1`: topic 1 being filtered for; empty if not specified (hex).
    /// - `topic2`: topic 2 being filtered for; empty if not specified (hex).
    /// - `topic3`: topic 3 being filtered for; empty if not specified (hex).
    #[builder(setter(into, strip_option), default)]
    logs_query_duration_seconds: Option<CounterVec>,

    /// Discrete number of log queries by address and topic.
    /// - `chain`: the chain name (or chain ID if the name is unknown) of the
    ///   chain the logs were queried on.
    /// - `contract_name`: name of the address if it is a known contract.
    /// - `address`: address being filtered for log events (hex).
    /// - `topic0`: topic 0 being filtered for; empty if not specified (hex).
    /// - `topic1`: topic 1 being filtered for; empty if not specified (hex).
    /// - `topic2`: topic 2 being filtered for; empty if not specified (hex).
    /// - `topic3`: topic 3 being filtered for; empty if not specified (hex).
    #[builder(setter(into, strip_option), default)]
    logs_query_count: Option<IntCounterVec>,

    /// Time taken to submit the transaction (not counting time for it to be
    /// included).
    /// - `chain`: the chain name (or chain ID if the name is unknown) of the
    ///   chain the tx occurred on.
    /// - `address_from`: source address of the transaction.
    /// - `address_to`: destination address of the transaction.
    /// - `txn_status`: `completed` or `failed`
    #[builder(setter(into, strip_option), default)]
    transaction_send_duration_seconds: Option<CounterVec>,

    /// Number of transactions sent.
    /// - `chain`: the chain name (or chain ID if the name is unknown) of the
    ///   chain the tx occurred on.
    /// - `address_from`: source address of the transaction.
    /// - `address_to`: destination address of the transaction.
    /// - `txn_status`: `dispatched`, `completed`, or `failed`
    #[builder(setter(into, strip_option), default)]
    transaction_send_total: Option<IntCounterVec>,
    // /// Gas spent on completed transactions.
    // /// - `chain`: the chain name (or ID if the name is unknown) of the chain the tx occurred
    // on. /// - `address_from`: source address of the transaction.
    // /// - `address_to`: destination address of the transaction.
    // #[builder(setter(into, strip_option), default)]
    // transaction_send_gas_eth_total: Option<CounterVec>,
}

/// An ethers-rs middleware that instruments calls with prometheus metrics. To
/// make this as flexible as possible, the metric vecs need to be created and
/// named externally, they should follow the naming convention here and must
/// include the described labels.
pub struct PrometheusMiddleware<M> {
    inner: Arc<M>,
    metrics: MiddlewareMetrics,
    conf: Arc<RwLock<PrometheusMiddlewareConf>>,
}

/// Configuration for the prometheus middleware. This can be loaded via serde.
#[derive(Default, Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
pub struct PrometheusMiddlewareConf {
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
                "address_to" => addr_to.as_str(),
                "txn_status" => if result.is_ok() { "completed" } else { "failed" }
            })
            .inc_by(duration);
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
    #[allow(clippy::redundant_closure)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_logs(&self, filter: &Filter) -> Result<Vec<Log>, Self::Error> {
        let start = Instant::now();
        let result = self.inner.get_logs(filter).await;
        if self.metrics.logs_query_duration_seconds.is_some()
            || self.metrics.logs_query_count.is_some()
        {
            let data = self.conf.read().await;
            let lookup_name = |addr: &Address| -> String {
                data.contracts
                    .get(addr)
                    .and_then(|c| c.name.as_deref())
                    .unwrap_or("unknown")
                    .to_owned()
            };
            let to_csv_str = |mut acc: String, i: String| {
                acc.push(',');
                acc += &i;
                acc
            };
            let chain = chain_name(&data.chain);
            let (address, contract_name) = filter
                .address
                .as_ref()
                .map(|addr| match addr {
                    ValueOrArray::Value(v) => {
                        let name = lookup_name(v);
                        let addr = v.encode_hex();
                        (addr, name)
                    }
                    ValueOrArray::Array(a) => {
                        let addrs = a
                            .iter()
                            .map(ToHex::encode_hex::<String>)
                            .reduce(to_csv_str)
                            .expect("Array is empty");
                        let names = a
                            .iter()
                            .map(|i| lookup_name(i))
                            .reduce(to_csv_str)
                            .expect("Array is empty");
                        (addrs, names)
                    }
                })
                .unwrap_or_else(|| ("*".to_owned(), "unknown".to_owned()));
            let topic_name = |v: &Option<H256>| -> String {
                v.map(|h| h.encode_hex()).unwrap_or_else(|| "*".to_owned())
            };
            let topic_str = |n: usize| -> String {
                filter.topics[n]
                    .as_ref()
                    .map(|t| match t {
                        Topic::Value(v) => topic_name(v),
                        Topic::Array(a) => a
                            .iter()
                            .map(topic_name)
                            .reduce(to_csv_str)
                            .expect("Array is empty"),
                    })
                    .unwrap_or_else(|| "*".to_owned())
            };
            let topic0 = topic_str(0);
            let topic1 = topic_str(1);
            let topic2 = topic_str(2);
            let topic3 = topic_str(3);
            let labels = hashmap! {
                "chain" => chain,
                "contract_name" => &contract_name,
                "address" => &address,
                "topic0" => &topic0,
                "topic1" => &topic1,
                "topic2" => &topic2,
                "topic3" => &topic3
            };
            if let Some(m) = &self.metrics.logs_query_count {
                m.with(&labels).inc();
            }
            if let Some(m) = &self.metrics.logs_query_duration_seconds {
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
    pub fn new(inner: M, metrics: MiddlewareMetrics, conf: PrometheusMiddlewareConf) -> Self {
        Self {
            inner: Arc::new(inner),
            metrics,
            conf: Arc::new(RwLock::new(conf)),
        }
    }
}

impl<M: Middleware> Debug for PrometheusMiddleware<M> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "PrometheusMiddleware({:?})", self.inner)
    }
}

/// Uniform way to name the chain.
fn chain_name(chain: &Option<ChainInfo>) -> &str {
    chain
        .as_ref()
        .and_then(|c| c.name.as_deref())
        .unwrap_or("unknown")
}
