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
use hyperlane_core::NativeToken;
use hyperlane_core::ReorgPeriod;
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

/// Expected label names for the `chain_config_reorg_period` metric.
pub const CHAIN_CONFIG_REORG_PERIOD_LABELS: &[&str] = &["chain"];
/// Help string for the metric.
pub const CHAIN_CONFIG_REORG_PERIOD_HELP: &str =
    "Configured reorg period (finality blocks) for the chain";

/// Expected label names for the `chain_config_estimated_block_time` metric.
pub const CHAIN_CONFIG_ESTIMATED_BLOCK_TIME_LABELS: &[&str] = &["chain"];
/// Help string for the metric.
pub const CHAIN_CONFIG_ESTIMATED_BLOCK_TIME_HELP: &str =
    "Configured estimated block time for the chain, in seconds";

/// Expected label names for the `chain_config_confirmations` metric.
pub const CHAIN_CONFIG_CONFIRMATIONS_LABELS: &[&str] = &["chain"];
/// Help string for the metric.
pub const CHAIN_CONFIG_CONFIRMATIONS_HELP: &str =
    "Configured number of blocks to wait before considering a transaction confirmed";

/// Expected label names for the `chain_config_info` metric.
pub const CHAIN_CONFIG_INFO_LABELS: &[&str] = &[
    "chain",
    "protocol",
    "technical_stack",
    "chain_id",
    "native_token_symbol",
    "domain_id",
];
/// Help string for the metric.
pub const CHAIN_CONFIG_INFO_HELP: &str =
    "Static chain configuration info, always set to 1. Labels expose string configuration values.";

/// Expected label names for the `chain_config_native_token_decimals` metric.
pub const CHAIN_CONFIG_NATIVE_TOKEN_DECIMALS_LABELS: &[&str] = &["chain"];
/// Help string for the metric.
pub const CHAIN_CONFIG_NATIVE_TOKEN_DECIMALS_HELP: &str =
    "Configured native token decimals for the chain";

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

    /// Configured number of blocks to wait before considering a transaction confirmed.
    pub confirmations: IntGaugeVec,

    /// Configured reorg period (finality blocks) for the chain.
    pub reorg_period: IntGaugeVec,

    /// Configured estimated block time for the chain, in seconds.
    pub estimated_block_time: GaugeVec,

    /// Static chain configuration info gauge (always 1).
    /// Labels: chain, protocol, technical_stack, native_token_symbol, domain_id.
    pub chain_config_info: IntGaugeVec,

    /// Configured native token decimals for the chain.
    pub native_token_decimals: IntGaugeVec,
}

impl ChainMetrics {
    /// constructor
    pub fn new(metrics: &CoreMetrics) -> Result<ChainMetrics> {
        let block_height_metrics =
            metrics.new_int_gauge("block_height", BLOCK_HEIGHT_HELP, BLOCK_HEIGHT_LABELS)?;
        let gas_price_metrics = metrics.new_gauge("gas_price", GAS_PRICE_HELP, GAS_PRICE_LABELS)?;
        let critical_error_metrics =
            metrics.new_int_gauge("critical_error", CRITICAL_ERROR_HELP, CRITICAL_ERROR_LABELS)?;
        let confirmations_metrics = metrics.new_int_gauge(
            "chain_config_confirmations",
            CHAIN_CONFIG_CONFIRMATIONS_HELP,
            CHAIN_CONFIG_CONFIRMATIONS_LABELS,
        )?;
        let reorg_period_metrics = metrics.new_int_gauge(
            "chain_config_reorg_period",
            CHAIN_CONFIG_REORG_PERIOD_HELP,
            CHAIN_CONFIG_REORG_PERIOD_LABELS,
        )?;
        let estimated_block_time_metrics = metrics.new_gauge(
            "chain_config_estimated_block_time",
            CHAIN_CONFIG_ESTIMATED_BLOCK_TIME_HELP,
            CHAIN_CONFIG_ESTIMATED_BLOCK_TIME_LABELS,
        )?;
        let chain_config_info_metrics = metrics.new_int_gauge(
            "chain_config_info",
            CHAIN_CONFIG_INFO_HELP,
            CHAIN_CONFIG_INFO_LABELS,
        )?;
        let native_token_decimals_metrics = metrics.new_int_gauge(
            "chain_config_native_token_decimals",
            CHAIN_CONFIG_NATIVE_TOKEN_DECIMALS_HELP,
            CHAIN_CONFIG_NATIVE_TOKEN_DECIMALS_LABELS,
        )?;
        let chain_metrics = ChainMetrics {
            block_height: block_height_metrics,
            gas_price: Some(gas_price_metrics),
            critical_error: critical_error_metrics,
            confirmations: confirmations_metrics,
            reorg_period: reorg_period_metrics,
            estimated_block_time: estimated_block_time_metrics,
            chain_config_info: chain_config_info_metrics,
            native_token_decimals: native_token_decimals_metrics,
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

    /// Set the static chain configuration metrics. Should be called once per chain.
    pub(crate) fn set_chain_config(
        &self,
        domain: &HyperlaneDomain,
        reorg_period: &ReorgPeriod,
        estimated_block_time: Duration,
        confirmations: u32,
        chain_id: &str,
        native_token: &NativeToken,
    ) {
        let chain = domain.name();
        let protocol = domain.domain_protocol().to_string();
        let technical_stack = domain.domain_technical_stack().to_string();
        let domain_id = domain.id().to_string();
        // Prefer symbol; fall back to denom for Cosmos chains
        let native_token_symbol = if native_token.symbol.is_empty() {
            &native_token.denom
        } else {
            &native_token.symbol
        };

        // Set confirmations
        self.confirmations
            .with(&hashmap! { "chain" => chain })
            .set(confirmations as i64);

        // Set reorg period (blocks to finality)
        match reorg_period.as_blocks() {
            Ok(blocks) => {
                self.reorg_period
                    .with(&hashmap! { "chain" => chain })
                    .set(blocks as i64);
            }
            Err(_) => {
                trace!(
                    chain,
                    ?reorg_period,
                    "Reorg period is not block-based; skipping chain_config_reorg_period metric"
                );
            }
        }

        // Set estimated block time in seconds
        self.estimated_block_time
            .with(&hashmap! { "chain" => chain })
            .set(estimated_block_time.as_secs_f64());

        // Set chain config info gauge (always 1, metadata in labels)
        self.chain_config_info
            .with(&hashmap! {
                "chain" => chain,
                "protocol" => protocol.as_str(),
                "technical_stack" => technical_stack.as_str(),
                "chain_id" => chain_id,
                "native_token_symbol" => native_token_symbol.as_str(),
                "domain_id" => domain_id.as_str(),
            })
            .set(1);

        // Set native token decimals
        self.native_token_decimals
            .with(&hashmap! { "chain" => chain })
            .set(native_token.decimals as i64);
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

    /// The reorg period of the chain
    pub reorg_period: ReorgPeriod,

    /// The estimated block time
    pub estimated_block_time: Duration,

    /// Number of blocks to wait before considering a transaction confirmed
    pub confirmations: u32,

    /// The chain ID (may differ from domain ID)
    pub chain_id: String,

    /// Native token info (decimals and symbol/denom)
    pub native_token: NativeToken,
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

        // Set static chain configuration metrics once on initialization
        chain_metrics.set_chain_config(
            &agent_metrics_conf.domain,
            &agent_metrics_conf.reorg_period,
            agent_metrics_conf.estimated_block_time,
            agent_metrics_conf.confirmations,
            &agent_metrics_conf.chain_id,
            &agent_metrics_conf.native_token,
        );

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

#[cfg(any(test, feature = "test-utils"))]
impl ChainMetrics {
    /// Build a `ChainMetrics` suitable for unit tests (no registry needed).
    pub fn test_default() -> Self {
        use prometheus::opts;
        ChainMetrics {
            block_height: IntGaugeVec::new(
                opts!("block_height", BLOCK_HEIGHT_HELP),
                BLOCK_HEIGHT_LABELS,
            )
            .expect("failed to create block_height metric"),
            gas_price: None,
            critical_error: IntGaugeVec::new(
                opts!("critical_error", CRITICAL_ERROR_HELP),
                CRITICAL_ERROR_LABELS,
            )
            .expect("failed to create critical_error metric"),
            confirmations: IntGaugeVec::new(
                opts!(
                    "chain_config_confirmations",
                    CHAIN_CONFIG_CONFIRMATIONS_HELP
                ),
                CHAIN_CONFIG_CONFIRMATIONS_LABELS,
            )
            .expect("failed to create chain_config_confirmations metric"),
            reorg_period: IntGaugeVec::new(
                opts!("chain_config_reorg_period", CHAIN_CONFIG_REORG_PERIOD_HELP),
                CHAIN_CONFIG_REORG_PERIOD_LABELS,
            )
            .expect("failed to create chain_config_reorg_period metric"),
            estimated_block_time: GaugeVec::new(
                opts!(
                    "chain_config_estimated_block_time",
                    CHAIN_CONFIG_ESTIMATED_BLOCK_TIME_HELP
                ),
                CHAIN_CONFIG_ESTIMATED_BLOCK_TIME_LABELS,
            )
            .expect("failed to create chain_config_estimated_block_time metric"),
            chain_config_info: IntGaugeVec::new(
                opts!("chain_config_info", CHAIN_CONFIG_INFO_HELP),
                CHAIN_CONFIG_INFO_LABELS,
            )
            .expect("failed to create chain_config_info metric"),
            native_token_decimals: IntGaugeVec::new(
                opts!(
                    "chain_config_native_token_decimals",
                    CHAIN_CONFIG_NATIVE_TOKEN_DECIMALS_HELP
                ),
                CHAIN_CONFIG_NATIVE_TOKEN_DECIMALS_LABELS,
            )
            .expect("failed to create chain_config_native_token_decimals metric"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::KnownHyperlaneDomain;

    #[test]
    fn test_set_chain_config_populates_metrics() {
        let metrics = ChainMetrics::test_default();

        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let reorg_period = ReorgPeriod::from_blocks(15);
        let estimated_block_time = Duration::from_secs_f64(12.5);
        let native_token = NativeToken {
            decimals: 18,
            symbol: "ETH".to_string(),
            denom: String::new(),
        };

        metrics.set_chain_config(
            &domain,
            &reorg_period,
            estimated_block_time,
            1,
            "1",
            &native_token,
        );

        // Verify confirmations
        let conf = metrics
            .confirmations
            .with(&hashmap! { "chain" => "ethereum" })
            .get();
        assert_eq!(conf, 1);

        // Verify reorg period
        let reorg = metrics
            .reorg_period
            .with(&hashmap! { "chain" => "ethereum" })
            .get();
        assert_eq!(reorg, 15);

        // Verify estimated block time
        let block_time = metrics
            .estimated_block_time
            .with(&hashmap! { "chain" => "ethereum" })
            .get();
        assert!((block_time - 12.5).abs() < f64::EPSILON);

        // Verify chain config info gauge is set to 1
        let info = metrics
            .chain_config_info
            .with(&hashmap! {
                "chain" => "ethereum",
                "protocol" => "ethereum",
                "technical_stack" => "other",
                "chain_id" => "1",
                "native_token_symbol" => "ETH",
                "domain_id" => "1",
            })
            .get();
        assert_eq!(info, 1);

        // Verify native token decimals
        let decimals = metrics
            .native_token_decimals
            .with(&hashmap! { "chain" => "ethereum" })
            .get();
        assert_eq!(decimals, 18);
    }

    #[test]
    fn test_set_chain_config_skips_tag_based_reorg_period() {
        let metrics = ChainMetrics::test_default();

        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let reorg_period = ReorgPeriod::Tag("finalized".to_string());
        let estimated_block_time = Duration::from_secs(12);
        let native_token = NativeToken {
            decimals: 18,
            symbol: "ETH".to_string(),
            denom: String::new(),
        };

        metrics.set_chain_config(
            &domain,
            &reorg_period,
            estimated_block_time,
            1,
            "1",
            &native_token,
        );

        // Reorg period should not be set for tag-based periods;
        // querying it returns the default (0)
        let reorg = metrics
            .reorg_period
            .with(&hashmap! { "chain" => "ethereum" })
            .get();
        assert_eq!(reorg, 0);

        // Other metrics should still be set
        let decimals = metrics
            .native_token_decimals
            .with(&hashmap! { "chain" => "ethereum" })
            .get();
        assert_eq!(decimals, 18);
    }

    #[test]
    fn test_set_chain_config_falls_back_to_denom() {
        let metrics = ChainMetrics::test_default();

        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let reorg_period = ReorgPeriod::from_blocks(5);
        let estimated_block_time = Duration::from_secs(6);
        let native_token = NativeToken {
            decimals: 6,
            symbol: String::new(),
            denom: "uatom".to_string(),
        };

        metrics.set_chain_config(
            &domain,
            &reorg_period,
            estimated_block_time,
            1,
            "cosmoshub-4",
            &native_token,
        );

        // Should fall back to denom when symbol is empty
        let info = metrics
            .chain_config_info
            .with(&hashmap! {
                "chain" => "ethereum",
                "protocol" => "ethereum",
                "technical_stack" => "other",
                "chain_id" => "cosmoshub-4",
                "native_token_symbol" => "uatom",
                "domain_id" => "1",
            })
            .get();
        assert_eq!(info, 1);
    }
}
