//! Integration tests for storing scraper events whose log meta could not be
//! resolved on-chain (zero block/transaction hashes, e.g. the Sealevel basic
//! log meta fallback). Such events must be durably persisted with a NULL
//! transaction relation and remain retrievable by sequence across restarts.

use std::sync::Arc;

use sea_orm::Database;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use migration::MigratorTrait;

use hyperlane_base::settings::IndexSettings;
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, Delivery, HyperlaneChain, HyperlaneDomain,
    HyperlaneDomainProtocol, HyperlaneDomainTechnicalStack, HyperlaneDomainType, HyperlaneLogStore,
    HyperlaneMessage, HyperlaneProvider, HyperlaneSequenceAwareIndexerStoreReader,
    HyperlaneWatermarkedLogStore, Indexed, InterchainGasPayment, LogMeta, TxnInfo, H256, H512,
    U256,
};

use crate::db::ScraperDb;

use super::HyperlaneDbStore;

/// Domain id seeded by the domain table migration (`sealeveltest1`).
const TEST_DOMAIN_ID: u32 = 13375;
/// Domain id seeded by the domain table migration (`sealeveltest2`).
const TEST_DESTINATION_DOMAIN_ID: u32 = 13376;

/// Provider that panics on any call: events with unresolvable log meta must be
/// storable without any RPC access.
#[derive(Debug)]
struct UnusableProvider {
    domain: HyperlaneDomain,
}

impl HyperlaneChain for UnusableProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(UnusableProvider {
            domain: self.domain.clone(),
        })
    }
}

#[async_trait::async_trait]
impl HyperlaneProvider for UnusableProvider {
    async fn get_block_by_height(&self, _height: u64) -> ChainResult<BlockInfo> {
        panic!("fallback events must not require block lookups")
    }

    async fn get_txn_by_hash(&self, _hash: &H512) -> ChainResult<TxnInfo> {
        panic!("fallback events must not require transaction lookups")
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        panic!("fallback events must not require RPC calls")
    }

    async fn get_balance(&self, _address: String) -> ChainResult<U256> {
        panic!("fallback events must not require RPC calls")
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        panic!("fallback events must not require RPC calls")
    }
}

fn test_domain() -> HyperlaneDomain {
    HyperlaneDomain::Unknown {
        domain_id: TEST_DOMAIN_ID,
        domain_name: "sealeveltest1".to_owned(),
        domain_type: HyperlaneDomainType::LocalTestChain,
        domain_protocol: HyperlaneDomainProtocol::Sealevel,
        domain_technical_stack: HyperlaneDomainTechnicalStack::Other,
    }
}

/// Log meta as produced by the Sealevel basic log meta fallback: the block
/// number (slot) is known but the block/transaction could not be resolved.
fn fallback_log_meta(address: H256, block_number: u64) -> LogMeta {
    LogMeta {
        address,
        block_number,
        block_hash: H256::zero(),
        transaction_id: H512::zero(),
        transaction_index: 0,
        log_index: U256::zero(),
    }
}

async fn build_store(postgres_url: &str, mailbox: H256, igp: H256) -> HyperlaneDbStore {
    let domain = test_domain();
    let provider = Arc::new(UnusableProvider {
        domain: domain.clone(),
    });
    HyperlaneDbStore::new(
        ScraperDb::connect(postgres_url)
            .await
            .expect("connect to test postgres"),
        domain,
        mailbox,
        igp,
        provider,
        &IndexSettings::default(),
        None,
    )
    .await
    .expect("build HyperlaneDbStore")
}

async fn assert_retrievable_by_sequence(
    store: &HyperlaneDbStore,
    message: &HyperlaneMessage,
    payment: &InterchainGasPayment,
    sequence: u32,
) {
    let fetched_message =
        HyperlaneSequenceAwareIndexerStoreReader::<HyperlaneMessage>::retrieve_by_sequence(
            store, sequence,
        )
        .await
        .expect("retrieve message by sequence");
    assert_eq!(fetched_message.as_ref(), Some(message));

    let fetched_payment =
        HyperlaneSequenceAwareIndexerStoreReader::<InterchainGasPayment>::retrieve_by_sequence(
            store, sequence,
        )
        .await
        .expect("retrieve payment by sequence");
    assert_eq!(fetched_payment.as_ref(), Some(payment));

    let fetched_delivery =
        HyperlaneSequenceAwareIndexerStoreReader::<Delivery>::retrieve_by_sequence(store, sequence)
            .await
            .expect("retrieve delivery by sequence");
    assert_eq!(fetched_delivery, Some(message.id()));

    // The transaction relation is NULL for fallback events, so the log block
    // number (derived via tx -> block) is unknown rather than fabricated.
    assert_eq!(
        HyperlaneSequenceAwareIndexerStoreReader::<HyperlaneMessage>::retrieve_log_block_number_by_sequence(store, sequence).await.unwrap(),
        None
    );
    assert_eq!(
        HyperlaneSequenceAwareIndexerStoreReader::<InterchainGasPayment>::retrieve_log_block_number_by_sequence(store, sequence).await.unwrap(),
        None
    );
    assert_eq!(
        HyperlaneSequenceAwareIndexerStoreReader::<Delivery>::retrieve_log_block_number_by_sequence(store, sequence).await.unwrap(),
        None
    );
}

/// Fallback dispatch/payment/delivery events (zero block/transaction hashes)
/// must be stored in the normal scraper tables, survive a restart, and be
/// idempotent to re-store, so the sequence-aware cursor can advance without
/// ever dropping them.
#[tokio::test]
async fn test_fallback_events_persist_and_survive_restart() -> eyre::Result<()> {
    const SEQUENCE: u32 = 7;

    let postgres_container = Postgres::default().start().await.unwrap();
    let host_port = postgres_container.get_host_port_ipv4(5432).await.unwrap();
    let postgres_url = format!("postgresql://postgres:postgres@127.0.0.1:{host_port}/postgres");

    let db = Database::connect(&postgres_url).await?;
    migration::Migrator::up(&db, None).await?;

    let mailbox = H256::from_low_u64_be(111);
    let igp = H256::from_low_u64_be(222);

    let message = HyperlaneMessage {
        version: 3,
        nonce: SEQUENCE,
        origin: TEST_DOMAIN_ID,
        destination: TEST_DESTINATION_DOMAIN_ID,
        sender: H256::from_low_u64_be(1),
        recipient: H256::from_low_u64_be(2),
        body: vec![1, 2, 3, 4],
    };
    let payment = InterchainGasPayment {
        message_id: message.id(),
        destination: TEST_DESTINATION_DOMAIN_ID,
        payment: U256::from(1000),
        // NOTE: no trailing zeros spanning base-10000 digits — the pre-existing
        // `decimal_to_u256` read path drops the BigDecimal exponent and would
        // otherwise mangle the value (e.g. 50000 reads back as 5).
        gas_amount: U256::from(12345),
    };

    let store = build_store(&postgres_url, mailbox, igp).await;

    // Store all three event types with unresolved (zero-hash) log meta.
    let stored = HyperlaneLogStore::<HyperlaneMessage>::store_logs(
        &store,
        &[(
            Indexed::new(message.clone()).with_sequence(SEQUENCE),
            fallback_log_meta(mailbox, 10_000),
        )],
    )
    .await?;
    assert_eq!(stored, 1, "fallback dispatch must be stored");

    let stored = HyperlaneLogStore::<InterchainGasPayment>::store_logs(
        &store,
        &[(
            Indexed::new(payment.clone()).with_sequence(SEQUENCE),
            fallback_log_meta(igp, 10_001),
        )],
    )
    .await?;
    assert_eq!(stored, 1, "fallback payment must be stored");

    let stored = HyperlaneLogStore::<Delivery>::store_logs(
        &store,
        &[(
            Indexed::new(message.id()).with_sequence(SEQUENCE),
            fallback_log_meta(mailbox, 10_002),
        )],
    )
    .await?;
    assert_eq!(stored, 1, "fallback delivery must be stored");

    // The cursor advances from the returned logs regardless of storage (see
    // `dedupe_and_store_logs`), so durability must not depend on it.
    HyperlaneWatermarkedLogStore::<HyperlaneMessage>::store_high_watermark(&store, 10_002).await?;

    assert_retrievable_by_sequence(&store, &message, &payment, SEQUENCE).await;

    // Simulate a restart: a brand new store over the same database.
    drop(store);
    let store = build_store(&postgres_url, mailbox, igp).await;
    assert_retrievable_by_sequence(&store, &message, &payment, SEQUENCE).await;

    // Re-storing the same fallback events (e.g. the cursor re-querying the
    // sequence after a restart) must be idempotent.
    for (stored, event) in [
        HyperlaneLogStore::<HyperlaneMessage>::store_logs(
            &store,
            &[(
                Indexed::new(message.clone()).with_sequence(SEQUENCE),
                fallback_log_meta(mailbox, 10_000),
            )],
        )
        .await?,
        HyperlaneLogStore::<InterchainGasPayment>::store_logs(
            &store,
            &[(
                Indexed::new(payment.clone()).with_sequence(SEQUENCE),
                fallback_log_meta(igp, 10_001),
            )],
        )
        .await?,
        HyperlaneLogStore::<Delivery>::store_logs(
            &store,
            &[(
                Indexed::new(message.id()).with_sequence(SEQUENCE),
                fallback_log_meta(mailbox, 10_002),
            )],
        )
        .await?,
    ]
    .into_iter()
    .zip(["dispatch", "payment", "delivery"])
    {
        assert_eq!(stored, 0, "re-storing fallback {event} must be idempotent");
    }

    assert_retrievable_by_sequence(&store, &message, &payment, SEQUENCE).await;

    // No `Migrator::down` teardown: the test data intentionally contains NULL
    // transaction relations, which `down` (SET NOT NULL) rejects, and the
    // container is disposable anyway.
    Ok(())
}
