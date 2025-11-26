use super::hub_whale_pool::HubWhalePool;
use super::kaspa_whale_pool::KaspaWhalePool;
use super::round_trip::do_round_trip;
use super::round_trip::TaskArgs;
use super::round_trip::TaskResources;
use super::stats::write_metadata;
use super::stats::StatsWriter;
use chrono::{DateTime, Utc};
use corelib::api::base::RateLimitConfig;
use corelib::api::client::HttpClient;
use corelib::wallet::Network;
use eyre::Result;
use rand_distr::{Distribution, Exp};
use std::time::SystemTime;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::x::args::SimulateTrafficCli;
use hyperlane_core::H256;
use tracing::info;

pub struct Params {
    pub time_limit: Duration,
    pub ops_per_minute: u64,
    pub max_wait_for_cancel: Duration,
}

impl Params {
    pub fn distr_time(&self) -> Exp<f64> {
        Exp::new(self.ops_per_second() / 1000.0).unwrap()
    }

    pub fn ops_per_second(&self) -> f64 {
        self.ops_per_minute as f64 / 60.0
    }

    pub fn max_ops(&self) -> u64 {
        (self.time_limit.as_secs_f64() * self.ops_per_second()) as u64
    }
}

pub struct SimulateTrafficArgs {
    pub params: Params,
    pub task_args: TaskArgs,
    pub kaspa_whale_secrets: Vec<String>,
    pub hub_whale_priv_keys: Vec<String>,
    pub kaspa_whale_wallet_dir_prefix: Option<String>,
    pub kaspa_wrpc_url: String,
    pub output_dir: String,
    pub hub_rpc_url: String,
    pub hub_grpc_url: String,
    pub hub_chain_id: String,
    pub hub_prefix: String,
    pub hub_denom: String,
    pub hub_decimals: u32,
    pub kaspa_rest_url: String,
    pub kaspa_network: Network,
}

impl TryFrom<SimulateTrafficCli> for SimulateTrafficArgs {
    type Error = eyre::Error;

    fn try_from(cli: SimulateTrafficCli) -> Result<Self, Self::Error> {
        let addr = kaspa_addresses::Address::try_from(cli.escrow_address.clone())?;
        let kaspa_network = match cli.kaspa_network.to_lowercase().as_str() {
            "testnet" => Network::KaspaTest10,
            "mainnet" => Network::KaspaMainnet,
            _ => return Err(eyre::eyre!("invalid kaspa network: {}", cli.kaspa_network)),
        };
        Ok(SimulateTrafficArgs {
            params: Params {
                time_limit: std::time::Duration::from_secs(cli.time_limit),
                ops_per_minute: cli.ops_per_minute,
                max_wait_for_cancel: std::time::Duration::from_secs(cli.cancel_wait),
            },
            task_args: TaskArgs {
                domain_kas: cli.domain_kas,
                token_kas_placeholder: cli.token_kas_placeholder,
                domain_hub: cli.domain_hub,
                token_hub: cli.token_hub,
                escrow_address: addr,
                deposit_amount: cli.deposit_amount,
                withdrawal_fee_pct: cli.withdrawal_fee_pct,
            },
            kaspa_whale_secrets: cli.kaspa_whale_secrets,
            hub_whale_priv_keys: cli.hub_whale_priv_keys,
            kaspa_whale_wallet_dir_prefix: cli.kaspa_whale_wallet_dir_prefix,
            kaspa_wrpc_url: cli.kaspa_wrpc_url,
            output_dir: cli.output_dir,
            hub_rpc_url: cli.hub_rpc_url,
            hub_grpc_url: cli.hub_grpc_url,
            hub_chain_id: cli.hub_chain_id,
            hub_prefix: cli.hub_prefix,
            hub_denom: cli.hub_denom,
            hub_decimals: cli.hub_decimals,
            kaspa_rest_url: cli.kaspa_rest_url,
            kaspa_network,
        })
    }
}

pub struct TrafficSim {
    params: Params,
    resources: TaskResources,
    kaspa_whale_pool: KaspaWhalePool,
    hub_whale_pool: HubWhalePool,
    output_dir: String,
}

impl TrafficSim {
    pub async fn new(args: SimulateTrafficArgs) -> Result<Self> {
        info!(
            "Initializing whale pools: kaspa_whales={} hub_whales={} network={:?}",
            args.kaspa_whale_secrets.len(),
            args.hub_whale_priv_keys.len(),
            args.kaspa_network
        );

        let kaspa_whale_pool = KaspaWhalePool::new(
            args.kaspa_whale_secrets,
            args.kaspa_wrpc_url.clone(),
            args.kaspa_network.clone(),
            args.kaspa_whale_wallet_dir_prefix,
        )
        .await?;

        let hub_whale_pool = HubWhalePool::new(
            args.hub_whale_priv_keys,
            args.hub_rpc_url.clone(),
            args.hub_grpc_url.clone(),
            args.hub_chain_id.clone(),
            args.hub_prefix.clone(),
            args.hub_denom.clone(),
            args.hub_decimals,
        )
        .await?;

        let first_hub_whale = hub_whale_pool.select_whale();
        let resources = TaskResources {
            args: args.task_args,
            hub: first_hub_whale.provider.clone(),
            kas_rest: HttpClient::new(args.kaspa_rest_url.clone(), RateLimitConfig::default()),
            kaspa_network: args.kaspa_network.clone(),
        };

        Ok(TrafficSim {
            params: args.params,
            resources,
            kaspa_whale_pool,
            hub_whale_pool,
            output_dir: args.output_dir,
        })
    }

    pub async fn run(&self) -> Result<()> {
        let mut rng = rand::rng();

        let max_ops = self.params.max_ops();
        info!(
            "Starting simulation: max_ops={} time_limit={}s ops_per_minute={} kaspa_whales={} hub_whales={}",
            max_ops,
            self.params.time_limit.as_secs(),
            self.params.ops_per_minute,
            self.kaspa_whale_pool.count(),
            self.hub_whale_pool.count()
        );

        let random_filename = H256::random();
        let now = SystemTime::now();
        let datetime: DateTime<Utc> = now.into();
        let stats_file_path = format!(
            "{}/stats_{}_{}.jsonl",
            self.output_dir,
            random_filename,
            datetime.format("%Y-%m-%d_%H-%M-%S")
        );
        let metadata_file_path = format!(
            "{}/metadata_{}_{}.json",
            self.output_dir,
            random_filename,
            datetime.format("%Y-%m-%d_%H-%M-%S")
        );

        let stats_writer = StatsWriter::new(stats_file_path.clone())?;
        info!("Writing stats to: {}", stats_file_path);

        let (stats_tx, mut stats_rx) = mpsc::channel(10000);

        let collector_handle = tokio::spawn(async move {
            let mut count = 0u64;
            while let Some(stats) = stats_rx.recv().await {
                stats_writer.log_stat(&stats);
                if let Err(e) = stats_writer.write_stat(&stats) {
                    tracing::error!("stat write error: error={:?}", e);
                }
                count += 1;
                if count % 10 == 0 {
                    info!("stats written: count={}", count);
                }
            }
            info!("stats collection finished: total={}", count);
            count
        });

        let start_time = Instant::now();
        let mut total_ops = 0u64;
        let cancel = CancellationToken::new();

        while start_time.elapsed() < self.params.time_limit {
            let kaspa_whale = self.kaspa_whale_pool.select_whale();
            let hub_whale = self.hub_whale_pool.select_whale();

            let tx_clone = stats_tx.clone();
            let r = self.resources.clone();
            let task_id = total_ops;
            let cancel_token_clone = cancel.clone();

            tokio::spawn(async move {
                do_round_trip(
                    r,
                    kaspa_whale,
                    hub_whale,
                    &tx_clone,
                    task_id,
                    cancel_token_clone,
                )
                .await;
                drop(tx_clone);
            });

            total_ops += 1;

            let sleep_millis = self.params.distr_time().sample(&mut rng) as u64;
            tokio::time::sleep(Duration::from_millis(sleep_millis)).await;

            if total_ops % 10 == 0 {
                info!(
                    "ops started: count={} elapsed={}s",
                    total_ops,
                    start_time.elapsed().as_secs()
                );
            }
        }

        info!("time limit reached, waiting for tasks to finish");
        drop(stats_tx);
        tokio::time::sleep(self.params.max_wait_for_cancel).await;
        cancel.cancel();

        let stats_count = collector_handle.await?;
        info!("stats collection complete: count={}", stats_count);

        let total_spend = total_ops * self.resources.args.deposit_amount;
        info!("writing metadata to: {}", metadata_file_path);
        write_metadata(&metadata_file_path, total_spend, total_ops)?;

        info!("simulation complete");
        info!("stats file: {}", stats_file_path);
        info!("metadata file: {}", metadata_file_path);

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::H256;

    #[test]
    fn test_h256_random_stringify() {
        let h = H256::random();
        let s = format!("{:?}", h);
        println!("s: {}", s);
    }
}
