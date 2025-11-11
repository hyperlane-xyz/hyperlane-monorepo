use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use ethers::utils::hex;
use ethers_prometheus::middleware::PrometheusMiddlewareConf;
use eyre::eyre;
use prometheus::{opts, IntGaugeVec, Registry};
use reqwest::Url;
use tokio::time::error::Elapsed;

use hyperlane_base::db::DB;
use hyperlane_base::settings::{
    ChainConf, ChainConnectionConf, CoreContractAddresses, IndexSettings, Settings, SignerConf,
    TracingConfig,
};
use hyperlane_base::{
    AgentMetadata, AgentMetrics, BaseAgent, ChainMetrics, CoreMetrics, RuntimeMetrics,
    BLOCK_HEIGHT_HELP, BLOCK_HEIGHT_LABELS, CRITICAL_ERROR_HELP, CRITICAL_ERROR_LABELS,
};
use hyperlane_core::{
    config::OpSubmissionConfig, HyperlaneDomain, IndexMode, KnownHyperlaneDomain, ReorgPeriod, H256,
};
use hyperlane_ethereum as h_eth;
use lander::DispatcherMetrics;

use crate::settings::{matching_list::MatchingList, RelayerSettings};

use super::Relayer;

fn generate_test_core_contract_addresses() -> CoreContractAddresses {
    CoreContractAddresses {
        mailbox: H256::from_slice(
            hex::decode("000000000000000000000000598facE78a4302f11E3de0bee1894Da0b2Cb71F8")
                .unwrap()
                .as_slice(),
        ),
        interchain_gas_paymaster: H256::from_slice(
            hex::decode("000000000000000000000000c756cFc1b7d0d4646589EDf10eD54b201237F5e8")
                .unwrap()
                .as_slice(),
        ),
        validator_announce: H256::from_slice(
            hex::decode("0000000000000000000000001b33611fCc073aB0737011d5512EF673Bff74962")
                .unwrap()
                .as_slice(),
        ),
        merkle_tree_hook: H256::from_slice(
            hex::decode("000000000000000000000000AD34A66Bf6dB18E858F6B686557075568c6E031C")
                .unwrap()
                .as_slice(),
        ),
    }
}

fn generate_test_chain_conf(
    domain: HyperlaneDomain,
    signer: Option<SignerConf>,
    rpc: &str,
) -> ChainConf {
    ChainConf {
        domain,
        signer,
        submitter: Default::default(),
        estimated_block_time: Duration::from_secs_f64(1.1),
        reorg_period: ReorgPeriod::None,
        addresses: generate_test_core_contract_addresses(),
        connection: ChainConnectionConf::Ethereum(h_eth::ConnectionConf {
            rpc_connection: h_eth::RpcConnectionConf::Http {
                url: Url::parse(rpc).unwrap(),
            },
            transaction_overrides: h_eth::TransactionOverrides {
                gas_price: None,
                gas_limit: None,
                max_fee_per_gas: None,
                max_priority_fee_per_gas: None,
                ..Default::default()
            },
            op_submission_config: OpSubmissionConfig {
                batch_contract_address: None,
                max_batch_size: 1,
                ..Default::default()
            },
        }),
        metrics_conf: PrometheusMiddlewareConf {
            contracts: HashMap::new(),
            chain: None,
        },
        index: IndexSettings {
            from: 0,
            chunk_size: 1,
            mode: IndexMode::Block,
        },
        ignore_reorg_reports: false,
    }
}

/// Builds a test RelayerSetting
fn generate_test_relayer_settings(
    db_path: &Path,
    chains: Vec<(String, ChainConf)>,
    origin_chains: &[HyperlaneDomain],
    destination_chains: &[HyperlaneDomain],
    metrics_port: u16,
) -> RelayerSettings {
    let chains = chains
        .into_iter()
        .map(|(_, conf)| (conf.domain.clone(), conf))
        .collect::<HashMap<_, _>>();

    let domains = chains
        .keys()
        .map(|domain| (domain.name().to_string(), domain.clone()))
        .collect();

    RelayerSettings {
        base: Settings {
            domains,
            chains,
            metrics_port,
            tracing: TracingConfig::default(),
        },
        db: db_path.to_path_buf(),
        origin_chains: origin_chains.iter().cloned().collect(),
        destination_chains: destination_chains.iter().cloned().collect(),
        gas_payment_enforcement: Vec::new(),
        whitelist: MatchingList::default(),
        blacklist: MatchingList::default(),
        address_blacklist: Vec::new(),
        transaction_gas_limit: None,
        skip_transaction_gas_limit_for: HashSet::new(),
        allow_local_checkpoint_syncers: true,
        metric_app_contexts: Vec::new(),
        allow_contract_call_caching: true,
        ism_cache_configs: Default::default(),
        max_retries: 1,
        tx_id_indexing_enabled: true,
        igp_indexing_enabled: true,
    }
}

#[tokio::test]
#[tracing_test::traced_test]
async fn test_failed_build_destinations() {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path();

    let chains = vec![
        (
            KnownHyperlaneDomain::Arbitrum.to_string(),
            generate_test_chain_conf(
                HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                None,
                // these urls are not expected to be live
                "http://localhost:8545",
            ),
        ),
        (
            KnownHyperlaneDomain::Ethereum.to_string(),
            generate_test_chain_conf(
                HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
                None,
                // these urls are not expected to be live
                "http://localhost:8545",
            ),
        ),
    ];
    let origin_chains = &[
        HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
    ];
    let destination_chains = &[
        HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
    ];
    let metrics_port = 27001;
    let settings = generate_test_relayer_settings(
        db_path,
        chains,
        origin_chains,
        destination_chains,
        metrics_port,
    );

    let registry = Registry::new();
    let core_metrics = Arc::new(CoreMetrics::new("relayer", 4000, registry).unwrap());
    let chain_metrics = ChainMetrics {
        block_height: IntGaugeVec::new(
            opts!("block_height", BLOCK_HEIGHT_HELP),
            BLOCK_HEIGHT_LABELS,
        )
        .unwrap(),
        gas_price: None,
        critical_error: IntGaugeVec::new(
            opts!("critical_error", CRITICAL_ERROR_HELP),
            CRITICAL_ERROR_LABELS,
        )
        .unwrap(),
    };

    let db = DB::from_path(db_path).unwrap();

    let dispatcher_metrics = DispatcherMetrics::new(core_metrics.registry())
        .expect("Creating dispatcher metrics is infallible");

    let destinations = Relayer::build_destinations(
        &settings,
        db,
        core_metrics,
        &chain_metrics,
        dispatcher_metrics,
    )
    .await;

    assert_eq!(destinations.len(), 2);
    assert!(destinations.contains_key(&HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)));
    assert!(destinations.contains_key(&HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum)));

    // Arbitrum chain should not have any errors because it's ChainConf exists
    let metric = chain_metrics
        .critical_error
        .get_metric_with_label_values(&["arbitrum"])
        .unwrap();
    assert_eq!(metric.get(), 0);

    // Ethereum chain should not have any errors because it's ChainConf exists
    let metric = chain_metrics
        .critical_error
        .get_metric_with_label_values(&["ethereum"])
        .unwrap();
    assert_eq!(metric.get(), 0);

    // Optimism chain should error because it is missing ChainConf
    let metric = chain_metrics
        .critical_error
        .get_metric_with_label_values(&["optimism"])
        .unwrap();
    assert_eq!(metric.get(), 1);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_failed_build_origin() {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path();

    let chains = vec![(
        KnownHyperlaneDomain::Arbitrum.to_string(),
        generate_test_chain_conf(
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            None,
            // these urls are not expected to be live
            "http://localhost:8545",
        ),
    )];
    let origin_chains = &[
        HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
    ];
    let destination_chains = &[
        HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
    ];
    let metrics_port = 27002;
    let settings = generate_test_relayer_settings(
        db_path,
        chains,
        origin_chains,
        destination_chains,
        metrics_port,
    );

    let registry = Registry::new();
    let core_metrics = CoreMetrics::new("relayer", 4000, registry).unwrap();
    let chain_metrics = ChainMetrics {
        block_height: IntGaugeVec::new(
            opts!("block_height", BLOCK_HEIGHT_HELP),
            BLOCK_HEIGHT_LABELS,
        )
        .unwrap(),
        gas_price: None,
        critical_error: IntGaugeVec::new(
            opts!("critical_error", CRITICAL_ERROR_HELP),
            CRITICAL_ERROR_LABELS,
        )
        .unwrap(),
    };

    let db = DB::from_path(db_path).expect("Failed to initialize database");
    let origins =
        Relayer::build_origins(&settings, db, Arc::new(core_metrics), &chain_metrics).await;

    assert_eq!(origins.len(), 1);
    assert!(origins.contains_key(&HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)));

    // Arbitrum chain should not have any errors because it's ChainConf exists
    let metric = chain_metrics
        .critical_error
        .get_metric_with_label_values(&["arbitrum"])
        .unwrap();
    assert_eq!(metric.get(), 0);

    // Ethereum chain should error because it is missing ChainConf
    let metric = chain_metrics
        .critical_error
        .get_metric_with_label_values(&["ethereum"])
        .unwrap();
    assert_eq!(metric.get(), 1);

    // Optimism chain should error because it is missing ChainConf
    let metric = chain_metrics
        .critical_error
        .get_metric_with_label_values(&["optimism"])
        .unwrap();
    assert_eq!(metric.get(), 1);
}

async fn build_relayer(settings: RelayerSettings) -> eyre::Result<Relayer> {
    let agent_metadata = AgentMetadata::new("relayer_git_hash".into());

    let metrics = settings.as_ref().metrics("relayer")?;
    let task_monitor = tokio_metrics::TaskMonitor::new();
    let agent_metrics = AgentMetrics::new(&metrics)?;
    let chain_metrics = ChainMetrics::new(&metrics)?;
    let runtime_metrics = RuntimeMetrics::new(&metrics, task_monitor)?;

    let (_, tokio_server) = console_subscriber::ConsoleLayer::new();

    Relayer::from_settings(
        agent_metadata,
        settings,
        metrics,
        agent_metrics,
        chain_metrics,
        runtime_metrics,
        tokio_server,
    )
    .await
}

async fn check_relayer_metrics(agent: Relayer, metrics_port: u16, chain_count: u32) {
    let _ = tokio::task::spawn(async move {
        agent.run().await;
    });

    let metrics_url = format!("http://localhost:{metrics_port}/metrics");
    let sleep_duration = Duration::from_secs(3);
    let metrics = "hyperlane_critical_error";
    loop {
        let res = reqwest::get(&metrics_url).await;
        let response = match res {
            Ok(s) => s,
            _ => {
                tokio::time::sleep(sleep_duration).await;
                continue;
            }
        };

        let status = response.status();
        if status.is_success() {
            if let Ok(body) = response.text().await {
                let matched_lines: eyre::Result<Vec<u32>> = body
                    .lines()
                    .filter(|l| l.starts_with(metrics))
                    .map(|l| {
                        let value = l.rsplit_once(' ').ok_or(eyre!("Unknown metric format"))?.1;
                        Ok(value.parse::<u32>()?)
                    })
                    .collect();
                let failed_chain_count: u32 = matched_lines.unwrap_or_default().iter().sum();

                if failed_chain_count == chain_count {
                    break;
                }
            }
        }
        tokio::time::sleep(sleep_duration).await;
    }
}

/// Run relayer for 50s to ensure it doesn't crash
async fn test_relayer_started_successfully(
    agent: Relayer,
    metrics_port: u16,
    failed_chain_count: u32,
) -> Result<(), Elapsed> {
    let future = check_relayer_metrics(agent, metrics_port, failed_chain_count);
    tokio::time::timeout(Duration::from_secs(50), future).await
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_from_settings_and_run_happy_path() {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path();
    let chains = vec![(
        "arbitrum".to_string(),
        generate_test_chain_conf(
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            None,
            // these urls are not expected to be live
            "http://localhost:8545",
        ),
    )];
    let origin_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
    let destination_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
    let metrics_port = 27003;
    let settings = generate_test_relayer_settings(
        db_path,
        chains,
        origin_chains,
        destination_chains,
        metrics_port,
    );

    let agent = build_relayer(settings)
        .await
        .expect("Failed to build relayer");

    let failed_chain_count = 1;
    assert!(
        test_relayer_started_successfully(agent, metrics_port, failed_chain_count)
            .await
            .is_ok()
    );
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_from_settings_and_run_missing_chain_configs() {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path();
    let chains = vec![(
        "arbitrum".to_string(),
        generate_test_chain_conf(
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            None,
            // these urls are not expected to be live
            "http://localhost:8545",
        ),
    )];
    let origin_chains = &[
        HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
    ];
    let destination_chains = &[
        HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
    ];
    let metrics_port = 27004;
    let settings = generate_test_relayer_settings(
        db_path,
        chains,
        origin_chains,
        destination_chains,
        metrics_port,
    );

    let agent = build_relayer(settings)
        .await
        .expect("Failed to build relayer");

    let failed_chain_count = 3;
    assert!(
        test_relayer_started_successfully(agent, metrics_port, failed_chain_count)
            .await
            .is_ok()
    );
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_from_settings_and_run_bad_rpc() {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path();

    let chains = vec![(
        KnownHyperlaneDomain::Arbitrum.to_string(),
        generate_test_chain_conf(
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            None,
            // these urls are not expected to be live
            "http://localhost:9999/rpc",
        ),
    )];
    let origin_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
    let destination_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
    let metrics_port = 27005;
    let settings = generate_test_relayer_settings(
        db_path,
        chains,
        origin_chains,
        destination_chains,
        metrics_port,
    );

    let agent = build_relayer(settings)
        .await
        .expect("Failed to build relayer");

    let failed_chain_count = 1;
    assert!(
        test_relayer_started_successfully(agent, metrics_port, failed_chain_count)
            .await
            .is_ok()
    );
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_from_settings_and_run_less_destinations() {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path();

    let chains = vec![
        (
            KnownHyperlaneDomain::Arbitrum.to_string(),
            generate_test_chain_conf(
                HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                None,
                // these urls are not expected to be live
                "http://localhost:8545",
            ),
        ),
        (
            KnownHyperlaneDomain::Ethereum.to_string(),
            generate_test_chain_conf(
                HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
                None,
                // these urls are not expected to be live
                "http://localhost:8545",
            ),
        ),
    ];
    let origin_chains = &[
        HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
    ];
    let destination_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
    let metrics_port = 27006;
    let settings = generate_test_relayer_settings(
        db_path,
        chains,
        origin_chains,
        destination_chains,
        metrics_port,
    );

    let agent = build_relayer(settings)
        .await
        .expect("Failed to build relayer");

    let failed_chain_count = 3;
    assert!(
        test_relayer_started_successfully(agent, metrics_port, failed_chain_count)
            .await
            .is_ok()
    );
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_from_settings_and_run_bad_signer() {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path();
    let chains = vec![(
        "arbitrum".to_string(),
        generate_test_chain_conf(
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            Some(SignerConf::HexKey { key: H256::zero() }),
            // these urls are not expected to be live
            "http://localhost:8545",
        ),
    )];
    let origin_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
    let destination_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
    let metrics_port = 27007;
    let settings = generate_test_relayer_settings(
        db_path,
        chains,
        origin_chains,
        destination_chains,
        metrics_port,
    );

    let agent = build_relayer(settings)
        .await
        .expect("Failed to build relayer");

    let failed_chain_count = 1;
    assert!(
        test_relayer_started_successfully(agent, metrics_port, failed_chain_count)
            .await
            .is_ok()
    );
}
