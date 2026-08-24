//! Integration tests for storing scraper events whose log meta could not be
//! resolved on-chain (zero block/transaction hashes, e.g. the Sealevel basic
//! log meta fallback). Such events must be durably persisted with a NULL
//! transaction relation and remain retrievable by sequence across restarts.

use std::{collections::HashMap, sync::Arc};

use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use migration::MigratorTrait;

use hyperlane_base::settings::{CoreContractAddresses, IndexSettings};
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, Delivery, HyperlaneChain, HyperlaneDomain,
    HyperlaneDomainProtocol, HyperlaneDomainTechnicalStack, HyperlaneDomainType, HyperlaneLogStore,
    HyperlaneMessage, HyperlaneProvider, HyperlaneSequenceAwareIndexerStoreReader, Indexed,
    InterchainGasPayment, LogMeta, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};

use crate::db::{
    ScraperDb, StorableDelivery, StorableMessage, StorablePayment, StorableRawMessageDispatch,
    StorableTxn,
};

use super::{
    storage::{txn_id_for_meta, TxnWithId},
    HyperlaneDbStore,
};

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
        CoreContractAddresses {
            mailbox,
            interchain_gas_paymaster: igp,
            ..Default::default()
        },
        provider,
        &IndexSettings::default(),
        None,
    )
    .await
    .expect("build HyperlaneDbStore")
}

async fn seed_resolved_transaction(store: &HyperlaneDbStore) -> eyre::Result<(LogMeta, i64)> {
    const RESOLVED_BLOCK_NUMBER: u64 = 20_000;
    let block_hash = H256::from_low_u64_be(333);
    let transaction_id = H512::from_low_u64_be(444);
    store
        .db
        .store_blocks(
            TEST_DOMAIN_ID,
            [BlockInfo {
                hash: block_hash,
                timestamp: 1_700_000_000,
                number: RESOLVED_BLOCK_NUMBER,
            }]
            .into_iter(),
        )
        .await?;
    let block_id = store
        .db
        .get_block_basic([&block_hash].into_iter())
        .await?
        .pop()
        .expect("seeded block")
        .id;
    store
        .db
        .store_txns(
            [StorableTxn {
                info: TxnInfo {
                    hash: transaction_id,
                    gas_limit: U256::one(),
                    max_priority_fee_per_gas: None,
                    max_fee_per_gas: None,
                    gas_price: None,
                    nonce: 1,
                    sender: H256::from_low_u64_be(1),
                    recipient: Some(H256::from_low_u64_be(2)),
                    receipt: Some(TxnReceiptInfo {
                        gas_used: U256::one(),
                        cumulative_gas_used: U256::one(),
                        effective_gas_price: None,
                    }),
                    raw_input_data: None,
                },
                block_id,
            }]
            .into_iter(),
        )
        .await?;
    let transaction_db_id = store
        .db
        .get_txn_ids([&transaction_id].into_iter())
        .await?
        .get(&transaction_id)
        .copied()
        .expect("seeded transaction");

    Ok((
        LogMeta {
            address: H256::zero(),
            block_number: RESOLVED_BLOCK_NUMBER,
            block_hash,
            transaction_id,
            transaction_index: 0,
            log_index: U256::zero(),
        },
        transaction_db_id,
    ))
}

async fn message_time_created(store: &HyperlaneDbStore, nonce: u32) -> eyre::Result<String> {
    let row = store
        .db
        .clone_connection()
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT time_created::text AS time_created FROM message WHERE origin = $1 AND nonce = $2",
            [
                i32::try_from(TEST_DOMAIN_ID)?.into(),
                i32::try_from(nonce)?.into(),
            ],
        ))
        .await?
        .expect("stored message");
    Ok(row.try_get("", "time_created")?)
}

async fn delivery_time_created(store: &HyperlaneDbStore, message_id: H256) -> eyre::Result<String> {
    let row = store
        .db
        .clone_connection()
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT time_created::text AS time_created FROM delivered_message WHERE msg_id = $1",
            [message_id.as_bytes().to_vec().into()],
        ))
        .await?
        .expect("stored delivery");
    Ok(row.try_get("", "time_created")?)
}

async fn payment_row_counts(store: &HyperlaneDbStore, sequence: u32) -> eyre::Result<(i64, i64)> {
    let row = store
        .db
        .clone_connection()
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT COUNT(*)::bigint AS row_count, COUNT(*) FILTER (WHERE tx_id IS NULL)::bigint AS null_count FROM gas_payment WHERE domain = $1 AND sequence = $2",
            [
                i32::try_from(TEST_DOMAIN_ID)?.into(),
                i64::from(sequence).into(),
            ],
        ))
        .await?
        .expect("stored payment");
    Ok((
        row.try_get("", "row_count")?,
        row.try_get("", "null_count")?,
    ))
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

#[test]
fn null_transaction_relation_requires_exact_fallback_sentinel() {
    let fallback = fallback_log_meta(H256::zero(), 1);
    assert_eq!(txn_id_for_meta(&HashMap::new(), &fallback), Some(None));

    // Cosmos block-level events have no transaction but retain a real block
    // hash. They are not the Sealevel basic-meta fallback and must keep their
    // pre-existing retry/skip behavior until block-backed storage is modeled.
    let block_event = LogMeta {
        block_hash: H256::from_low_u64_be(1),
        ..fallback
    };
    assert_eq!(txn_id_for_meta(&HashMap::new(), &block_event), None);

    let tx_hash = H512::from_low_u64_be(2);
    let resolved = LogMeta {
        transaction_id: tx_hash,
        block_hash: H256::from_low_u64_be(1),
        ..fallback
    };
    let txns = HashMap::from([(
        tx_hash,
        TxnWithId {
            hash: tx_hash,
            id: 7,
        },
    )]);
    assert_eq!(txn_id_for_meta(&txns, &resolved), Some(Some(7)));
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

    let fallback_payment = (
        Indexed::new(payment.clone()).with_sequence(SEQUENCE),
        fallback_log_meta(igp, 10_001),
    );
    let stored = HyperlaneLogStore::<InterchainGasPayment>::store_logs(
        &store,
        &[fallback_payment.clone(), fallback_payment],
    )
    .await?;
    assert_eq!(
        stored, 1,
        "duplicate fallback payments in one batch must be idempotent"
    );
    assert_eq!(
        payment_row_counts(&store, SEQUENCE).await?,
        (1, 1),
        "fallback payment must have exactly one NULL-tx row"
    );

    let stored = HyperlaneLogStore::<Delivery>::store_logs(
        &store,
        &[(
            Indexed::new(message.id()).with_sequence(SEQUENCE),
            fallback_log_meta(mailbox, 10_002),
        )],
    )
    .await?;
    assert_eq!(stored, 1, "fallback delivery must be stored");

    assert_retrievable_by_sequence(&store, &message, &payment, SEQUENCE).await;
    let first_scraped_at = message_time_created(&store, SEQUENCE).await?;
    let first_delivery_scraped_at = delivery_time_created(&store, message.id()).await?;

    // Simulate a restart: a brand new store over the same database.
    drop(store);
    let store = build_store(&postgres_url, mailbox, igp).await;
    assert_retrievable_by_sequence(&store, &message, &payment, SEQUENCE).await;
    assert_eq!(
        message_time_created(&store, SEQUENCE).await?,
        first_scraped_at,
        "fallback replays must preserve the first scrape time used for age alerts"
    );
    assert_eq!(
        delivery_time_created(&store, message.id()).await?,
        first_delivery_scraped_at,
        "fallback replays must preserve the first delivery scrape time"
    );

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

    // Separate #9284 scraper processes can overlap. Their fallback payment
    // read/reconcile/write sections must serialize across connections.
    let concurrent_payment = InterchainGasPayment {
        message_id: H256::from_low_u64_be(999),
        ..payment.clone()
    };
    let second_store = build_store(&postgres_url, mailbox, igp).await;
    let first_payment = [(
        Indexed::new(concurrent_payment.clone()).with_sequence(SEQUENCE + 1),
        fallback_log_meta(igp, 10_003),
    )];
    let second_payment = [(
        Indexed::new(concurrent_payment).with_sequence(SEQUENCE + 1),
        fallback_log_meta(igp, 10_003),
    )];
    let (first, second) = tokio::join!(
        HyperlaneLogStore::<InterchainGasPayment>::store_logs(&store, &first_payment,),
        HyperlaneLogStore::<InterchainGasPayment>::store_logs(&second_store, &second_payment,),
    );
    assert_eq!(
        first? + second?,
        1,
        "concurrent fallback payment stores must be idempotent"
    );

    // Enrichment is monotonic: once hashes/FKs are resolved, a later fallback
    // replay must not erase them. A resolved payment replaces its fallback row
    // instead of coexisting and double-counting.
    let (resolved_meta, transaction_db_id) = seed_resolved_transaction(&store).await?;
    store
        .db
        .store_raw_message_dispatches(
            TEST_DOMAIN_ID,
            &mailbox,
            [StorableRawMessageDispatch {
                msg: &message,
                meta: &resolved_meta,
            }]
            .into_iter(),
        )
        .await?;
    store
        .db
        .store_dispatched_messages(
            TEST_DOMAIN_ID,
            &mailbox,
            [StorableMessage {
                msg: message.clone(),
                meta: &resolved_meta,
                txn_id: Some(transaction_db_id),
                id_override: None,
            }]
            .into_iter(),
        )
        .await?;
    store
        .db
        .store_deliveries(
            TEST_DOMAIN_ID,
            mailbox,
            [StorableDelivery {
                message_id: message.id(),
                sequence: Some(i64::from(SEQUENCE)),
                meta: &resolved_meta,
                txn_id: Some(transaction_db_id),
            }]
            .into_iter(),
        )
        .await?;
    store
        .db
        .store_payments(
            TEST_DOMAIN_ID,
            &igp,
            &[StorablePayment {
                payment: &payment,
                sequence: Some(i64::from(SEQUENCE)),
                meta: &resolved_meta,
                txn_id: Some(transaction_db_id),
            }],
        )
        .await?;

    for stored in [
        HyperlaneLogStore::<HyperlaneMessage>::store_logs(
            &store,
            &[(
                Indexed::new(message.clone()).with_sequence(SEQUENCE),
                fallback_log_meta(mailbox, 10_000),
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
        HyperlaneLogStore::<InterchainGasPayment>::store_logs(
            &store,
            &[(
                Indexed::new(payment.clone()).with_sequence(SEQUENCE),
                fallback_log_meta(igp, 10_001),
            )],
        )
        .await?,
    ] {
        assert_eq!(stored, 0, "fallback replay must remain idempotent");
    }

    assert_eq!(
        store
            .db
            .retrieve_dispatched_tx_id(TEST_DOMAIN_ID, &mailbox, SEQUENCE)
            .await?,
        Some(transaction_db_id)
    );
    assert_eq!(
        store
            .db
            .retrieve_delivered_message_tx_id(TEST_DOMAIN_ID, &mailbox, SEQUENCE)
            .await?,
        Some(transaction_db_id)
    );
    assert_eq!(
        store
            .db
            .retrieve_payment_tx_id(TEST_DOMAIN_ID, &igp, SEQUENCE)
            .await?,
        Some(transaction_db_id)
    );
    let raw = store
        .db
        .retrieve_raw_message_dispatch_by_id(&message.id())
        .await?
        .expect("raw dispatch");
    assert_eq!(
        raw.origin_tx_hash,
        hyperlane_core::h512_to_bytes(&resolved_meta.transaction_id)
    );
    assert_eq!(raw.origin_block_hash, resolved_meta.block_hash.as_bytes());
    assert_eq!(
        raw.origin_block_height,
        i64::try_from(resolved_meta.block_number)?,
        "fallback replay must keep the height paired with the resolved block hash"
    );
    assert_eq!(
        payment_row_counts(&store, SEQUENCE).await?,
        (1, 0),
        "resolved payment must replace its NULL-tx fallback row"
    );

    // No `Migrator::down` teardown: the test data intentionally contains NULL
    // transaction relations, which `down` (SET NOT NULL) rejects, and the
    // container is disposable anyway.
    Ok(())
}
