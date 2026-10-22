use std::collections::BTreeMap;

use ethers_prometheus::middleware::PrometheusMiddlewareConf;
use prometheus::Registry;
use reqwest::Url;
use sea_orm::{DatabaseBackend, MockDatabase};

use hyperlane_base::{
    settings::{ChainConf, ChainConnectionConf, CoreContractAddresses, Settings, TracingConfig},
    ChainMetrics,
};
use hyperlane_core::{
    config::OpSubmissionConfig, IndexMode, KnownHyperlaneDomain, ReorgPeriod, H160,
};
use hyperlane_ethereum as h_eth;

use super::*;

fn generate_test_scraper_settings() -> ScraperSettings {
    let chains = [(
        "arbitrum".to_string(),
        ChainConf {
            domain: HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            signer: None,
            ccs_signer: None,
            identity: None,
            submitter: Default::default(),
            estimated_block_time: Duration::from_secs_f64(1.1),
            reorg_period: ReorgPeriod::None,
            addresses: CoreContractAddresses {
                mailbox: "0x598facE78a4302f11E3de0bee1894Da0b2Cb71F8"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
                interchain_gas_paymaster: "0xc756cFc1b7d0d4646589EDf10eD54b201237F5e8"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
                validator_announce: "0x1b33611fCc073aB0737011d5512EF673Bff74962"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
                merkle_tree_hook: "0xAD34A66Bf6dB18E858F6B686557075568c6E031C"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
            },
            connection: ChainConnectionConf::Ethereum(h_eth::ConnectionConf {
                rpc_connection: h_eth::RpcConnectionConf::Http {
                    url: Url::parse("https://sepolia-rollup.arbitrum.io/rpc").unwrap(),
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
                consider_null_transaction_receipt: false,
                fallback_hedge: None,
                mev_submission: None,
            }),
            metrics_conf: PrometheusMiddlewareConf {
                contracts: HashMap::new(),
                chain: None,
                rpc_role: Default::default(),
            },
            index: IndexSettings {
                from: 0,
                chunk_size: 1,
                mode: IndexMode::Block,
                idle_sleep_duration: Duration::from_secs(5),
                configured_interval: None,
            },
            confirmations: Default::default(),
            chain_id: Default::default(),
            ignore_reorg_reports: false,
            native_token: Default::default(),
        },
    )];

    let chains = chains
        .into_iter()
        .map(|(_, conf)| (conf.domain.clone(), conf))
        .collect::<HashMap<_, _>>();

    let domains = chains
        .keys()
        .map(|domain| (domain.name().to_string(), domain.clone()))
        .collect();

    ScraperSettings {
        base: Settings {
            domains,
            chains,
            metrics_port: 5000,
            tracing: TracingConfig::default(),
        },
        db: String::new(),
        db_max_connections: 10,
        db_acquire_timeout: Duration::from_secs(15),
        chains_to_scrape: vec![],
        ccr_routers: HashMap::new(),
    }
}

#[tokio::test]
#[tracing_test::traced_test]
async fn test_failed_build_chain_scrapers() {
    let mut settings = generate_test_scraper_settings();

    let registry = Registry::new();
    let core_metrics = Arc::new(CoreMetrics::new("scraper", 4000, registry).unwrap());
    let chain_metrics = ChainMetrics::test_default();

    // set the chains we want to scrape
    settings.chains_to_scrape = vec![
        HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
        HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
    ];

    // Create MockDatabase with mock query results
    let db = MockDatabase::new(DatabaseBackend::Postgres).append_query_results([
        // First query result
        vec![[("height", sea_orm::Value::BigInt(Some(100)))]
            .into_iter()
            .collect::<BTreeMap<_, _>>()],
    ]);
    let scraper_db = ScraperDb::with_connection(db.into_connection());

    let scrapers =
        Scraper::build_chain_scrapers(&settings, core_metrics, &chain_metrics, scraper_db).await;

    assert_eq!(scrapers.len(), 1);
    assert!(scrapers.contains_key(&(KnownHyperlaneDomain::Arbitrum as u32)));

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
}
