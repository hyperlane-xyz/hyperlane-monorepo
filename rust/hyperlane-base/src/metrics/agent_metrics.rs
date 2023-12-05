use std::time::Duration;

use derive_builder::Builder;
use derive_new::new;
use eyre::Result;
use hyperlane_core::metrics::agent::u256_as_scaled_f64;
use hyperlane_core::HyperlaneDomain;
use hyperlane_core::HyperlaneProvider;
use maplit::hashmap;
use prometheus::GaugeVec;
use tokio::time::MissedTickBehavior;
use tracing::{trace, warn};

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

/// Agent-specific metrics
#[derive(Clone, Builder)]
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
    #[builder(setter(into, strip_option), default)]
    wallet_balance: Option<GaugeVec>,
}

pub(crate) fn create_agent_metrics(metrics: &CoreMetrics) -> Result<AgentMetrics> {
    Ok(AgentMetricsBuilder::default()
        .wallet_balance(metrics.new_gauge(
            "wallet_balance",
            WALLET_BALANCE_HELP,
            WALLET_BALANCE_LABELS,
        )?)
        .build()?)
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

/// Utility struct to update agent metrics for a given chain
#[derive(new)]
pub struct AgentMetricsUpdater {
    metrics: AgentMetrics,
    conf: AgentMetricsConf,
    provider: Box<dyn HyperlaneProvider>,
}

impl AgentMetricsUpdater {
    async fn update_wallet_balances(&self) {
        let Some(wallet_addr) = self.conf.address.clone() else {
            return;
        };
        let wallet_name = self.conf.name.clone();
        let Some(wallet_balance_metric) = self.metrics.wallet_balance.clone() else {
            return;
        };
        let chain = self.conf.domain.name();

        match self.provider.get_balance(wallet_addr.clone()).await {
            Ok(balance) => {
                // Okay, so the native type is not a token, but whatever, close enough.
                // Note: This is ETH for many chains, but not all so that is why we use `N` and `Native`
                // TODO: can we get away with scaling as 18 in all cases here? I am guessing not.
                let balance = u256_as_scaled_f64(balance, self.conf.domain.domain_protocol());
                trace!("Wallet {wallet_name} ({wallet_addr}) on chain {chain} balance is {balance} of the native currency");
                wallet_balance_metric
                    .with(&hashmap! {
                    "chain" => chain,
                    "wallet_address" => wallet_addr.as_str(),
                    "wallet_name" => wallet_name.as_str(),
                    "token_address" => "none",
                    "token_symbol" => "Native",
                    "token_name" => "Native"
                }).set(balance)
            },
            Err(e) => warn!("Metric update failed for wallet {wallet_name} ({wallet_addr}) on chain {chain} balance for native currency; {e}")
        }
    }

    /// Periodically updates the metrics
    pub async fn start_updating_on_interval(self, period: Duration) {
        let mut interval = tokio::time::interval(period);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            self.update_wallet_balances().await;
            interval.tick().await;
        }
    }
}
