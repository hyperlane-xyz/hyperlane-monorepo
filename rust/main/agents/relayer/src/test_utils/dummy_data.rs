use std::{sync::Arc, time::Duration};

use hyperlane_base::{
    cache::{LocalCache, MeteredCache, OptionalCache},
    db::HyperlaneRocksDB,
    settings::{ChainConf, ChainConnectionConf, Settings},
    CoreMetrics,
};
use hyperlane_core::{HyperlaneDomain, H256};
use hyperlane_test::mocks::{MockMailboxContract, MockValidatorAnnounceContract};
use prometheus::{CounterVec, IntCounter, IntCounterVec, IntGauge, Opts, Registry};
use tokio::sync::RwLock;

use crate::{
    merkle_tree::builder::MerkleTreeBuilder,
    metrics::message_submission::MessageSubmissionMetrics,
    msg::{
        gas_payment::GasPaymentEnforcer,
        metadata::{
            BaseMetadataBuilder, DefaultIsmCache, IsmAwareAppContextClassifier,
            IsmCachePolicyClassifier,
        },
        pending_message::MessageContext,
        processor::test::DummyApplicationOperationVerifier,
    },
};

pub fn dummy_chain_conf(domain: &HyperlaneDomain) -> ChainConf {
    ChainConf {
        domain: domain.clone(),
        signer: Default::default(),
        submitter: Default::default(),
        estimated_block_time: Duration::from_secs_f64(1.1),
        reorg_period: Default::default(),
        addresses: Default::default(),
        connection: ChainConnectionConf::Ethereum(hyperlane_ethereum::ConnectionConf {
            rpc_connection: hyperlane_ethereum::RpcConnectionConf::Http {
                url: "http://example.com".parse().unwrap(),
            },
            transaction_overrides: Default::default(),
            op_submission_config: Default::default(),
        }),
        metrics_conf: Default::default(),
        index: Default::default(),
        ignore_reorg_reports: false,
    }
}

pub fn dummy_metadata_builder(
    origin_domain: &HyperlaneDomain,
    destination_domain: &HyperlaneDomain,
    db: &HyperlaneRocksDB,
    cache: OptionalCache<MeteredCache<LocalCache>>,
) -> BaseMetadataBuilder {
    let mut settings = Settings::default();
    settings.chains.insert(
        origin_domain.name().to_owned(),
        dummy_chain_conf(origin_domain),
    );
    settings.chains.insert(
        destination_domain.name().to_owned(),
        dummy_chain_conf(destination_domain),
    );
    let destination_chain_conf = settings.chain_setup(destination_domain).unwrap();
    let core_metrics = CoreMetrics::new("dummy_relayer", 37582, Registry::new()).unwrap();
    let default_ism_getter = DefaultIsmCache::new(Arc::new(
        MockMailboxContract::new_with_default_ism(H256::zero()),
    ));
    BaseMetadataBuilder::new(
        origin_domain.clone(),
        destination_chain_conf.clone(),
        Arc::new(RwLock::new(MerkleTreeBuilder::new())),
        Arc::new(MockValidatorAnnounceContract::default()),
        false,
        Arc::new(core_metrics),
        cache,
        db.clone(),
        IsmAwareAppContextClassifier::new(default_ism_getter.clone(), vec![]),
        IsmCachePolicyClassifier::new(default_ism_getter, Default::default()),
        None,
        false,
    )
}

pub fn dummy_submission_metrics() -> MessageSubmissionMetrics {
    MessageSubmissionMetrics {
        origin: "".to_string(),
        destination: "".to_string(),
        last_known_nonce: IntGauge::new("last_known_nonce_gauge", "help string").unwrap(),
        messages_processed: IntCounter::new("message_processed_gauge", "help string").unwrap(),
        metadata_build_count: IntCounterVec::new(
            Opts::new("metadata_build_count", "help string"),
            &["app_context", "origin", "remote", "status"],
        )
        .unwrap(),
        metadata_build_duration: CounterVec::new(
            Opts::new("metadata_build_duration", "help string"),
            &["app_context", "origin", "remote", "status"],
        )
        .unwrap(),
    }
}

pub fn dummy_message_context(
    base_metadata_builder: Arc<BaseMetadataBuilder>,
    db: &HyperlaneRocksDB,
    cache: OptionalCache<MeteredCache<LocalCache>>,
) -> MessageContext {
    MessageContext {
        destination_mailbox: Arc::new(MockMailboxContract::new_with_default_ism(H256::zero())),
        origin_db: Arc::new(db.clone()),
        cache,
        metadata_builder: base_metadata_builder,
        origin_gas_payment_enforcer: Arc::new(GasPaymentEnforcer::new([], db.clone())),
        transaction_gas_limit: Default::default(),
        metrics: dummy_submission_metrics(),
        application_operation_verifier: Some(Arc::new(DummyApplicationOperationVerifier {})),
    }
}
