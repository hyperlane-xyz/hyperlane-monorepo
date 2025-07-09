//! Metrics either related to the agents, or observed by them
#![allow(unexpected_cfgs)] // TODO: `rustc` 1.80.1 clippy issue

use std::sync::Arc;
use std::time::Duration;

use eyre::Result;
use hyperlane_core::metrics::agent::decimals_by_protocol;
use hyperlane_core::metrics::agent::u256_as_scaled_f64;
use hyperlane_core::metrics::agent::METRICS_SCRAPE_INTERVAL;
use hyperlane_core::HyperlaneDomain;
use hyperlane_core::HyperlaneProvider;
use maplit::hashmap;
use prometheus::GaugeVec;
use prometheus::IntGaugeVec;
use tokio::{task::JoinHandle, time::MissedTickBehavior};
use tracing::info_span;
use tracing::{debug, trace, warn, Instrument};

use crate::settings::ChainConf;
use crate::CoreMetrics;

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
pub const WALLET_BALANCE_HELP: &str =
    "Current native token balance for the wallet addresses in the `wallets` set";

/// Expected label names for the `block_height` metric.
pub const BLOCK_HEIGHT_LABELS: &[&str] = &["chain"];
/// Help string for the metric.
pub const BLOCK_HEIGHT_HELP: &str = "Tracks the current block height of the chain";

/// Expected label names for the `gas_price` metric.
pub const GAS_PRICE_LABELS: &[&str] = &["chain"];
/// Help string for the metric.
pub const GAS_PRICE_HELP: &str =
    "Tracks the current gas price of the chain, in the lowest denomination (e.g. wei)";

/// Expected label names for the `critical_error` metric.
pub const CRITICAL_ERROR_LABELS: &[&str] = &["chain"];
/// Help string for the metric.
pub const CRITICAL_ERROR_HELP: &str =
    "Boolean marker for critical errors on a chain, signalling loss of liveness";

/// Agent-specific metrics
#[derive(Clone, Debug)]
pub struct AgentMetrics {
    /// Current balance of native tokens for the
    /// wallet address.
    /// - `chain`: the chain name (or chain ID if the name is unknown) of the
    ///   chain the tx occurred on.
    /// - `wallet_address`: Address of the wallet holding the funds.
    /// - `wallet_name`: Name of the address holding the funds.
    /// - `token_address`: Address of the token.
    /// - `token_symbol`: Symbol of the token.
    /// - `token_name`: Full name of the token.
    wallet_balance: Option<GaugeVec>,
}

impl AgentMetrics {
    /// constructor
    pub fn new(metrics: &CoreMetrics) -> Result<AgentMetrics> {
        let agent_metrics = AgentMetrics {
            wallet_balance: Some(metrics.new_gauge(
                "wallet_balance",
                WALLET_BALANCE_HELP,
                WALLET_BALANCE_LABELS,
            )?),
        };
        Ok(agent_metrics)
    }
}

/// Chain-specific metrics
#[derive(Clone, Debug)]
pub struct ChainMetrics {
    /// Tracks the current block height of the chain.
    /// - `chain`: the chain name (or ID if the name is unknown) of the chain
    ///   the block number refers to.
    pub block_height: IntGaugeVec,

    /// Tracks the current gas price of the chain. Uses the base_fee_per_gas if
    /// available or else sets this to none.
    /// TODO: use the median of the transactions.
    /// - `chain`: the chain name (or chain ID if the name is unknown) of the
    ///   chain the gas price refers to.
    pub gas_price: Option<GaugeVec>,

    /// Boolean marker for critical errors on a chain, signalling loss of liveness.
    pub critical_error: IntGaugeVec,
}

impl ChainMetrics {
    /// constructor
    pub fn new(metrics: &CoreMetrics) -> Result<ChainMetrics> {
        let block_height_metrics =
            metrics.new_int_gauge("block_height", BLOCK_HEIGHT_HELP, BLOCK_HEIGHT_LABELS)?;
        let gas_price_metrics = metrics.new_gauge("gas_price", GAS_PRICE_HELP, GAS_PRICE_LABELS)?;
        let critical_error_metrics =
            metrics.new_int_gauge("critical_error", CRITICAL_ERROR_HELP, CRITICAL_ERROR_LABELS)?;
        let chain_metrics = ChainMetrics {
            block_height: block_height_metrics,
            gas_price: Some(gas_price_metrics),
            critical_error: critical_error_metrics,
        };
        Ok(chain_metrics)
    }

    pub(crate) fn set_gas_price(&self, chain: &str, price: f64) {
        if let Some(gas_price) = &self.gas_price {
            gas_price.with(&hashmap! { "chain" => chain }).set(price);
        }
    }

    pub(crate) fn set_block_height(&self, chain: &str, height: i64) {
        self.block_height
            .with(&hashmap! { "chain" => chain })
            .set(height);
    }

    /// Flag that a critical error has occurred on the chain
    pub fn set_critical_error(&self, chain: &str, is_critical: bool) {
        self.critical_error
            .with(&hashmap! { "chain" => chain })
            .set(is_critical as i64);
    }
}

/// Configuration for the prometheus middleware. This can be loaded via serde.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
pub struct AgentMetricsConf {
    /// The account to track
    #[cfg_attr(feature = "serde", serde(default))]
    pub address: Option<String>,

    /// Information about the chain this metric is for
    pub domain: HyperlaneDomain,

    /// Name of the agent the metrics are about
    pub name: String,
}

/// Utility struct to update various metrics using a standalone tokio task
pub struct ChainSpecificMetricsUpdater {
    agent_metrics: AgentMetrics,
    chain_metrics: ChainMetrics,
    conf: AgentMetricsConf,
    provider: Box<dyn HyperlaneProvider>,
}

impl ChainSpecificMetricsUpdater {
    /// Creates a new instance of the `MetricsUpdater`
    pub async fn new(
        chain_conf: &ChainConf,
        core_metrics: Arc<CoreMetrics>,
        agent_metrics: AgentMetrics,
        chain_metrics: ChainMetrics,
        agent_name: String,
    ) -> Result<Self> {
        let agent_metrics_conf = chain_conf.agent_metrics_conf(agent_name).await?;
        let provider = chain_conf.build_provider(&core_metrics).await?;

        Ok(Self {
            agent_metrics,
            chain_metrics,
            conf: agent_metrics_conf,
            provider,
        })
    }

    async fn update_agent_metrics(&self) {
        let Some(wallet_addr) = self.conf.address.clone() else {
            return;
        };
        let agent_name = self.conf.name.clone();
        let Some(wallet_balance_metric) = self.agent_metrics.wallet_balance.clone() else {
            return;
        };
        let chain = self.conf.domain.name();

        match self.provider.get_balance(wallet_addr.clone()).await {
            Ok(balance) => {
                let balance = u256_as_scaled_f64(balance, self.conf.domain.domain_protocol());
                trace!("Wallet {agent_name} ({wallet_addr}) on chain {chain} balance is {balance} of the native currency");
                wallet_balance_metric
                .with(&hashmap! {
                    "chain" => chain,
                    "wallet_address" => wallet_addr.as_str(),
                    "wallet_name" => agent_name.as_str(),
                    "token_address" => "none",
                    // Note: Whatever this `chain`'s native currency is
                    "token_symbol" => "Native",
                    "token_name" => "Native"
                }).set(balance)
            },
            Err(e) => warn!("Metric update failed for wallet {agent_name} ({wallet_addr}) on chain {chain} balance for native currency; {e}")
        }
    }

    async fn update_block_details(&self) {
        if let HyperlaneDomain::Unknown {
            domain_id,
            domain_name,
            ..
        } = &self.conf.domain
        {
            debug!(
                domain_id,
                domain_name, "Unknown domain, skipping chain metrics"
            );
            return;
        };
        let chain = self.conf.domain.name();
        debug!(chain, "Updating metrics");
        let chain_metrics = match self.provider.get_chain_metrics().await {
            Ok(Some(chain_metrics)) => chain_metrics,
            Err(err) => {
                warn!(chain, ?err, "Failed to get chain metrics");
                return;
            }
            _ => {
                debug!(chain, "No chain metrics available");
                return;
            }
        };

        let height = chain_metrics.latest_block.number as i64;
        trace!(chain, height, "Fetched block height for metrics");
        self.chain_metrics.set_block_height(chain, height);

        if self.chain_metrics.gas_price.is_some() {
            let protocol = self.conf.domain.domain_protocol();
            let decimals_scale = 10f64.powf(decimals_by_protocol(protocol).into());
            let gas = u256_as_scaled_f64(chain_metrics.min_gas_price.unwrap_or_default(), protocol)
                * decimals_scale;
            trace!(
                chain,
                gas = format!("{gas:.2}"),
                "Gas price updated for chain (using lowest denomination)"
            );
            self.chain_metrics.set_gas_price(chain, gas);
        }
    }

    /// Periodically updates the metrics
    pub async fn start_updating_on_interval(self, period: Duration) {
        let mut interval = tokio::time::interval(period);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            self.update_agent_metrics().await;
            self.update_block_details().await;
            interval.tick().await;
        }
    }

    /// Spawns a tokio task to update the metrics
    pub fn spawn(self) -> JoinHandle<()> {
        let name = format!("metrics::agent::{}", self.conf.domain.name());
        tokio::task::Builder::new()
            .name(&name)
            .spawn(
                async move {
                    self.start_updating_on_interval(METRICS_SCRAPE_INTERVAL)
                        .await;
                }
                .instrument(info_span!("MetricsUpdater")),
            )
            .expect("spawning tokio task from Builder is infallible")
    }
}
