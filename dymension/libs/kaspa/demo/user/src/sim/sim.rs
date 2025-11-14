use super::key_cosmos::EasyHubKey;
use super::round_trip::do_round_trip;
use super::round_trip::TaskArgs;
use super::round_trip::TaskResources;
use super::stats::write_metadata;
use super::stats::StatsWriter;
use super::worker::WorkerWallet;
use chrono::{DateTime, Utc};
use corelib::api::base::RateLimitConfig;
use corelib::api::client::HttpClient;
use corelib::wallet::EasyKaspaWallet;
use corelib::wallet::{EasyKaspaWalletArgs, Network};
use eyre::Result;
use hyperlane_cosmos::ConnectionConf as CosmosConnectionConf;
use hyperlane_cosmos::{native::ModuleQueryClient, CosmosProvider};
use kaspa_wallet_core::prelude::Secret;
use rand_distr::{Distribution, Exp};
use std::time::SystemTime;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::debug;

use crate::x::args::{SimulateTrafficCli, WalletCli};
use cosmos_sdk_proto::cosmos::bank::v1beta1::MsgSend;
use cosmos_sdk_proto::cosmos::base::v1beta1::Coin;
use cosmos_sdk_proto::traits::Message;
use cosmrs::Any;
use hyperlane_core::config::OpSubmissionConfig;
use hyperlane_core::ContractLocator;
use hyperlane_core::HyperlaneDomain;
use hyperlane_core::KnownHyperlaneDomain;
use hyperlane_core::NativeToken;
use hyperlane_core::H256;
use hyperlane_cosmos::RawCosmosAmount;
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;
use tracing::info;
use url::Url;

/// Minimum withdrawal amount for Kaspa (40 KAS in sompi)
pub const MIN_KASPA_WITHDRAWAL_SOMPI: u64 = 4_000_000_000;

async fn cosmos_provider(
    signer_key_hex: &str,
    rpc_url: &str,
    grpc_url: &str,
    chain_id: &str,
    prefix: &str,
    denom: &str,
    decimals: u32,
) -> Result<CosmosProvider<ModuleQueryClient>> {
    let conf = CosmosConnectionConf::new(
        vec![Url::parse(grpc_url).map_err(|e| eyre::eyre!("Invalid gRPC URL: {}", e))?],
        vec![Url::parse(rpc_url).map_err(|e| eyre::eyre!("Invalid RPC URL: {}", e))?],
        chain_id.to_string(),
        prefix.to_string(),
        denom.to_string(),
        RawCosmosAmount {
            amount: "100000000000.0".to_string(),
            denom: denom.to_string(),
        },
        32,
        OpSubmissionConfig::default(),
        NativeToken {
            decimals,
            denom: denom.to_string(),
        },
        1.0,
        None,
    )
    .map_err(|e| eyre::eyre!(e))?;
    let d = HyperlaneDomain::Known(KnownHyperlaneDomain::Osmosis);
    let locator = ContractLocator::new(&d, H256::zero());
    let hub_key = EasyHubKey::from_hex(signer_key_hex);
    let signer = Some(hub_key.signer());
    debug!("signer: {:?}", signer);
    let metrics = PrometheusClientMetrics::default();
    let chain = None;
    CosmosProvider::<ModuleQueryClient>::new(&conf, &locator, signer, metrics, chain)
        .map_err(eyre::Report::from)
}

pub struct Params {
    pub time_limit: Duration,          // total target simulation time
    pub budget: u64,                   // in sompi
    pub ops_per_minute: u64,           // osmosis does 90 per minute
    pub min_value: u64,                // in sompi
    pub hub_fund_amount: u64,          // in adym
    pub max_wait_for_cancel: Duration, // max time to wait for cancel
    pub simple_mode: bool,
}

impl Params {
    /// Used to draw value of each op, in sompi
    pub fn distr_value(&self) -> Exp<f64> {
        Exp::new(1.0 / self.op_budget()).unwrap()
    }
    /// Sample deposit value - must be at least MIN_KASPA_WITHDRAWAL_SOMPI
    pub fn sample_value(&self) -> u64 {
        if self.simple_mode {
            return self.min_value.max(MIN_KASPA_WITHDRAWAL_SOMPI);
        }
        let v = self.distr_value().sample(&mut rand::rng()) as u64;
        v.max(self.min_value).max(MIN_KASPA_WITHDRAWAL_SOMPI)
    }
    /// Used to draw time between ops, in milliseconds
    pub fn distr_time(&self) -> Exp<f64> {
        Exp::new(self.ops_per_second() / 1000.0).unwrap()
    }
    pub fn num_ops(&self) -> f64 {
        self.time_limit.as_secs_f64() * self.ops_per_second()
    }
    pub fn op_budget(&self) -> f64 {
        self.budget as f64 / self.num_ops()
    }
    pub fn ops_per_second(&self) -> f64 {
        self.ops_per_minute as f64 / 60.0
    }
}

pub struct SimulateTrafficArgs {
    pub params: Params,
    pub task_args: TaskArgs,
    pub wallet: WalletCli,
    pub hub_whale_priv_key: String,
    pub output_dir: String,
    pub hub_rpc_url: String,
    pub hub_grpc_url: String,
    pub hub_chain_id: String,
    pub hub_prefix: String,
    pub hub_denom: String,
    pub hub_decimals: u32,
    pub kaspa_rest_url: String,
}

impl TryFrom<SimulateTrafficCli> for SimulateTrafficArgs {
    type Error = eyre::Error;

    fn try_from(cli: SimulateTrafficCli) -> Result<Self, Self::Error> {
        let addr = kaspa_addresses::Address::try_from(cli.escrow_address.clone())?;
        Ok(SimulateTrafficArgs {
            params: Params {
                time_limit: std::time::Duration::from_secs(cli.time_limit),
                budget: cli.budget,
                ops_per_minute: cli.ops_per_minute,
                simple_mode: cli.simple,
                min_value: cli.min_deposit_sompi,
                hub_fund_amount: cli.hub_fund_amount,
                max_wait_for_cancel: std::time::Duration::from_secs(cli.cancel_wait),
            },
            task_args: TaskArgs {
                domain_kas: cli.domain_kas,
                token_kas_placeholder: cli.token_kas_placeholder,
                domain_hub: cli.domain_hub,
                token_hub: cli.token_hub,
                escrow_address: addr,
            },
            wallet: cli.wallet,
            hub_whale_priv_key: cli.hub_whale_priv_key,
            output_dir: cli.output_dir,
            hub_rpc_url: cli.hub_rpc_url,
            hub_grpc_url: cli.hub_grpc_url,
            hub_chain_id: cli.hub_chain_id,
            hub_prefix: cli.hub_prefix,
            hub_denom: cli.hub_denom,
            hub_decimals: cli.hub_decimals,
            kaspa_rest_url: cli.kaspa_rest_url,
        })
    }
}

pub struct TrafficSim {
    params: Params,
    resources: TaskResources,
    whale_wallet: EasyKaspaWallet,
    whale_secret: Secret,
    wrpc_url: String,
    output_dir: String,
}

impl TrafficSim {
    pub async fn new(args: SimulateTrafficArgs) -> Result<Self> {
        let wrpc_url = args.wallet.rpc_url.clone();
        let net = Network::KaspaTest10;
        let whale_secret = Secret::from(args.wallet.wallet_secret.clone());

        let w = EasyKaspaWallet::try_new(EasyKaspaWalletArgs {
            wallet_secret: args.wallet.wallet_secret,
            wrpc_url: wrpc_url.clone(),
            net: net.clone(),
            storage_folder: args.wallet.wallet_dir.clone(),
        })
        .await?;

        let resources = TaskResources {
            args: args.task_args,
            hub: cosmos_provider(
                &args.hub_whale_priv_key,
                &args.hub_rpc_url,
                &args.hub_grpc_url,
                &args.hub_chain_id,
                &args.hub_prefix,
                &args.hub_denom,
                args.hub_decimals,
            )
            .await?,
            kas_rest: HttpClient::new(args.kaspa_rest_url.clone(), RateLimitConfig::default()),
        };
        Ok(TrafficSim {
            params: args.params,
            resources,
            whale_wallet: w,
            whale_secret,
            wrpc_url,
            output_dir: args.output_dir,
        })
    }

    pub async fn run(&self) -> Result<()> {
        let mut rng = rand::rng();

        // Validate budget is sufficient for minimum withdrawals
        let min_budget_needed = (self.params.num_ops() * MIN_KASPA_WITHDRAWAL_SOMPI as f64) as u64;
        if self.params.budget < min_budget_needed {
            return Err(eyre::eyre!(
                "Budget {} sompi is insufficient. Need at least {} sompi for {} ops with 40 KAS minimum per withdrawal",
                self.params.budget,
                min_budget_needed,
                self.params.num_ops()
            ));
        }

        // Pre-create and fund worker wallets
        let estimated_ops = (self.params.num_ops() * 1.1) as usize; // 10% buffer
        info!("Creating and funding {} worker wallets", estimated_ops);

        let mut workers = Vec::new();
        for i in 0..estimated_ops {
            // Create worker
            let worker =
                WorkerWallet::create_new(i, self.wrpc_url.clone(), Network::KaspaTest10).await?;

            // Fund worker from whale
            let worker_address = worker.receive_address()?;
            // Fund each worker with 2x the budget, but ensure at least minimum withdrawal amount
            let fund_amount = (self.params.op_budget() as u64 * 2).max(MIN_KASPA_WITHDRAWAL_SOMPI);

            use kaspa_wallet_core::tx::{Fees, PaymentDestination, PaymentOutput};

            let dst = PaymentDestination::from(PaymentOutput::new(worker_address, fund_amount));
            let fees = Fees::from(0i64);

            self.whale_wallet
                .wallet
                .account()?
                .send(
                    dst,
                    None,
                    fees,
                    None,
                    self.whale_secret.clone(),
                    None,
                    &workflow_core::abortable::Abortable::new(),
                    None,
                )
                .await?;

            workers.push(worker);

            // Delay between funding to allow UTXO settlement
            if i > 0 && i % 10 == 0 {
                info!("Funded {}/{} workers", i + 1, estimated_ops);
            }
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }

        info!("All workers funded, starting simulation");

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
        info!("Writing stats to {}", stats_file_path);

        let (stats_tx, mut stats_rx) = mpsc::channel(100);

        let collector_handle = tokio::spawn(async move {
            let mut count = 0u64;
            while let Some(stats) = stats_rx.recv().await {
                stats_writer.log_stat(&stats);
                if let Err(e) = stats_writer.write_stat(&stats) {
                    tracing::error!("Failed to write stat: {:?}", e);
                }
                count += 1;
                if count % 10 == 0 {
                    info!("Wrote {} stats to file", count);
                }
            }
            info!("Total stats written: {}", count);
            count
        });

        let start_time = Instant::now();
        let mut total_ops = 0;
        let mut total_spend = 0;
        let cancel = CancellationToken::new();

        let mut worker_iter = workers.into_iter();

        while start_time.elapsed() < self.params.time_limit {
            let worker = match worker_iter.next() {
                Some(w) => w,
                None => {
                    info!("Ran out of pre-funded workers at {} ops", total_ops);
                    break;
                }
            };

            let nominal_value = self.params.sample_value();
            let tx_clone = stats_tx.clone();
            let r = self.resources.clone();
            let task_id = total_ops;
            let hub_key = EasyHubKey::new();
            fund_hub_addr(&hub_key, &r.hub, self.params.hub_fund_amount).await?;
            let cancel_token_clone = cancel.clone();

            tokio::spawn(async move {
                do_round_trip(
                    r,
                    worker,
                    nominal_value,
                    &tx_clone,
                    task_id,
                    hub_key,
                    cancel_token_clone,
                )
                .await;
                drop(tx_clone);
            });

            total_spend += nominal_value;
            total_ops += 1;

            let sleep_millis = self.params.distr_time().sample(&mut rng) as u64;
            tokio::time::sleep(Duration::from_millis(sleep_millis)).await;

            if total_ops % 10 == 0 {
                info!(
                    "Started {} ops, elapsed: {}s",
                    total_ops,
                    start_time.elapsed().as_secs()
                );
            }

            if self.params.simple_mode {
                break;
            }
        }

        info!("Waiting for tasks to finish");
        drop(stats_tx);
        tokio::time::sleep(self.params.max_wait_for_cancel).await;
        cancel.cancel();

        let stats_count = collector_handle.await?;
        info!("Total stats collected: {}", stats_count);

        info!("Writing metadata to {}", metadata_file_path);
        write_metadata(&metadata_file_path, total_spend, total_ops)?;

        info!("Simulation complete");
        info!("Stats file: {}", stats_file_path);
        info!("Metadata file: {}", metadata_file_path);

        Ok(())
    }
}

async fn fund_hub_addr(
    hub_key: &EasyHubKey,
    hub: &CosmosProvider<ModuleQueryClient>,
    amount: u64,
) -> Result<()> {
    let hub_addr = hub_key.signer().address_string.clone();
    debug!("funding hub address: {}", hub_addr);
    let rpc = hub.rpc();
    let msg = MsgSend {
        from_address: rpc.get_signer()?.address_string.clone(),
        to_address: hub_addr.clone(),
        amount: vec![Coin {
            amount: amount.to_string(),
            denom: "adym".to_string(),
        }],
    };
    let a = Any {
        type_url: "/cosmos.bank.v1beta1.MsgSend".to_string(),
        value: msg.encode_to_vec(),
    };
    let gas_limit = None;
    let response = rpc.send(vec![a], gas_limit).await;
    match response {
        Ok(response) => {
            // Check check_tx for errors first (mempool validation)
            if response.check_tx.code.is_err() {
                return Err(eyre::eyre!(
                    "Transaction failed during CheckTx with code {:?}: {}",
                    response.check_tx.code,
                    response.check_tx.log
                ));
            }
            // Then check tx_result for execution errors
            if response.tx_result.code.is_err() {
                return Err(eyre::eyre!(
                    "Transaction failed during DeliverTx with code {:?}: {}",
                    response.tx_result.code,
                    response.tx_result.log
                ));
            }
            info!("Funded hub address: {}", hub_addr);
            Ok(())
        }
        Err(e) => Err(eyre::eyre!("Failed to fund hub address: {:?}", e)),
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

    #[tokio::test]
    #[ignore = "requires playground to be up and populated"]
    async fn test_fund_hub_addr() {
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .init();
        let recipient = EasyHubKey::new();
        println!("recipient: {:?}", recipient.signer().address_string);
        let k = "7c3ea937a1578534cbe33bc22486d837436d99d0fb66cf1e5f9c9aa120e05964";
        let hub = cosmos_provider(
            &k,
            "https://rpc-dymension-playground35.mzonder.com:443",
            "https://grpc-dymension-playground35.mzonder.com:443",
            "dymension_3405-1",
            "dym",
            "adym",
            18,
        )
        .await
        .unwrap();
        fund_hub_addr(&recipient, &hub, 100).await.unwrap();
    }
}
