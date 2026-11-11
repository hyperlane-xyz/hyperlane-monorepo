#![allow(clippy::panic)] // Unexpected mock RPCs must fail the regression.

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use crate::near_head::{
    source::{Contracts, Event, EventData, Header},
    store::Store,
};
use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain, HyperlaneProvider,
    KnownHyperlaneDomain, LogMeta, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};
use migration::MigratorTrait;
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
use testcontainers::{runners::AsyncRunner, ImageExt};
use testcontainers_modules::postgres::Postgres;
use tokio::sync::Notify;

use super::*;

#[derive(Clone, Debug)]
struct PendingProvider {
    domain: HyperlaneDomain,
    calls: Arc<AtomicUsize>,
    gate: Option<Arc<Notify>>,
}

impl HyperlaneChain for PendingProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for PendingProvider {
    async fn get_block_by_height(&self, _: u64) -> ChainResult<BlockInfo> {
        panic!("confirmed event headers are already stored")
    }
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        if *hash == H512::from(H256::repeat_byte(0x66)) {
            if let Some(gate) = &self.gate {
                gate.notified().await;
            }
        }
        if *hash == H512::from(H256::repeat_byte(0xff)) {
            return std::future::pending().await;
        }
        Ok(TxnInfo {
            hash: *hash,
            gas_limit: U256::zero(),
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            gas_price: None,
            nonce: 0,
            sender: H256::repeat_byte(0x22),
            recipient: None,
            receipt: Some(TxnReceiptInfo {
                gas_used: U256::zero(),
                cumulative_gas_used: U256::zero(),
                effective_gas_price: None,
            }),
            raw_input_data: None,
        })
    }
    async fn is_contract(&self, _: &H256) -> ChainResult<bool> {
        panic!("unexpected RPC")
    }
    async fn get_balance(&self, _: String) -> ChainResult<U256> {
        panic!("unexpected RPC")
    }
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        panic!("unexpected RPC")
    }
}

#[tokio::test]
async fn all_transaction_types_enrich_before_confirmation_and_roll_back_with_their_fork(
) -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let db = Database::connect(&url).await?;
    migration::Migrator::up(&db, None).await?;
    let store = Store { db, domain: 1 };
    let contracts = Contracts {
        mailbox: H256::repeat_byte(1),
        hook: H256::repeat_byte(2),
        paymaster: H256::repeat_byte(3),
    };
    let anchor = Header {
        height: 0,
        timestamp: 1,
        hash: ethers::types::H256::repeat_byte(1),
        parent: ethers::types::H256::zero(),
    };
    let block = Header {
        height: 1,
        hash: ethers::types::H256::repeat_byte(2),
        ..anchor.clone()
    };
    store.initialize(&anchor, &contracts).await?;
    store
        .observe(&store.state().await?.expect("initialized"), &anchor, &block)
        .await?;
    let message = hyperlane_core::HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: 1,
        sender: H256::repeat_byte(0x11),
        destination: 2,
        recipient: H256::repeat_byte(0x33),
        body: vec![1],
    };
    let message_id = message.id();
    let event = Event {
        block_number: block.height,
        block_hash: block.hash,
        tx_hash: Some(H256::repeat_byte(0x44).into()),
        tx_index: 0,
        log_index: 0,
        address: contracts.mailbox,
        sequence: None,
        data: EventData::Dispatch(message.clone()),
    };
    let unknown_transaction = Event {
        tx_hash: None,
        tx_index: 1,
        log_index: 1,
        data: EventData::Dispatch(hyperlane_core::HyperlaneMessage {
            nonce: 1,
            ..message
        }),
        ..event.clone()
    };
    let gas = Event {
        log_index: 2,
        address: contracts.paymaster,
        data: EventData::Gas {
            message_id,
            destination: 2,
            gas: "1".into(),
            payment: "1".into(),
        },
        ..event.clone()
    };
    let delivery_id = H256::repeat_byte(0x55);
    let delivery = Event {
        log_index: 3,
        data: EventData::Delivery(delivery_id),
        ..event.clone()
    };
    store
        .append(
            &store.state().await?.expect("initialized"),
            &[(
                block.clone(),
                vec![
                    event.clone(),
                    unknown_transaction,
                    gas.clone(),
                    delivery.clone(),
                ],
            )],
        )
        .await?;
    let calls = Arc::new(AtomicUsize::new(0));
    let domain: HyperlaneDomain = KnownHyperlaneDomain::Ethereum.into();
    let gate = Arc::new(Notify::new());
    let enrichment_store = HyperlaneDbStore::new(
        crate::db::ScraperDb::with_connection(Database::connect(&url).await?),
        domain.clone(),
        hyperlane_base::settings::CoreContractAddresses::default(),
        Arc::new(PendingProvider {
            domain,
            calls: calls.clone(),
            gate: Some(gate.clone()),
        }),
    );
    let permits = Semaphore::new(1);
    let mut listener = sea_orm::sqlx::postgres::PgListener::connect(&url).await?;
    listener.listen("scraper_explorer_event").await?;
    for stream in ReceiptStream::ALL {
        assert_eq!(
            enrichment_store
                .db
                .pending_receipts(1, stream, 0)
                .await?
                .len(),
            1
        );
        let mut after = 0;
        assert_eq!(
            enrich_page(
                &enrichment_store,
                stream,
                &mut after,
                RECEIPT_TIMEOUT,
                &permits
            )
            .await,
            PageOutcome::Idle
        );
        let notification = timeout(Duration::from_secs(1), listener.recv()).await??;
        let payload: serde_json::Value = serde_json::from_str(notification.payload())?;
        let expected_id = if matches!(stream, ReceiptStream::Delivery) {
            delivery_id
        } else {
            message_id
        };
        assert_eq!(payload["messageId"], format!("{expected_id:x}"));
        assert!(enrichment_store
            .db
            .pending_receipts(1, stream, 0)
            .await?
            .is_empty());
    }
    let row = store
        .db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            r#"SELECT (SELECT count(*) FROM message_view) AS canonical,
           (SELECT count(*) FROM confirmed_delivered_message) AS confirmed_deliveries,
           (SELECT count(*) FROM confirmed_gas_payment) AS confirmed_payments,
           (SELECT count(*) FROM gas_payment_stream_cursor) AS gas_cursors,
           (SELECT encode(sender,'hex') FROM "transaction") AS sender"#,
        ))
        .await?
        .expect("enrichment result");
    assert_eq!(row.try_get::<i64>("", "canonical")?, 0);
    assert_eq!(row.try_get::<i64>("", "confirmed_deliveries")?, 0);
    assert_eq!(row.try_get::<i64>("", "confirmed_payments")?, 0);
    assert_eq!(row.try_get::<i64>("", "gas_cursors")?, 0);
    assert_eq!(row.try_get::<String>("", "sender")?, "22".repeat(32));
    assert_eq!(store.state().await?.expect("initialized").confirmed, 0);
    assert_eq!(calls.load(Ordering::Relaxed), 1);

    // A receipt completing after its fork was deleted must not recreate stale metadata.
    let pending_store = enrichment_store.clone();
    let meta = LogMeta {
        transaction_id: H256::repeat_byte(0x66).into(),
        block_hash: block.hash.into(),
        block_number: block.height,
        ..LogMeta::default()
    };
    let pending = tokio::spawn(async move {
        pending_store
            .ensure_transactions_for_known_blocks(
                std::iter::once(&meta),
                &RECEIPT_RPC_PERMITS,
                &Semaphore::new(1),
                &RECEIPT_DB_PERMITS,
            )
            .await
    });
    timeout(Duration::from_secs(5), async {
        while calls.load(Ordering::Relaxed) < 2 {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    store
        .rewind_to_confirmed(&store.state().await?.expect("initialized"))
        .await?;
    gate.notify_one();
    assert!(!pending.await??);
    let row = store
        .db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            r#"SELECT (SELECT count(*) FROM "transaction") AS transactions,
           (SELECT count(*) FROM raw_message_dispatch) AS dispatches,
           (SELECT count(*) FROM gas_payment) AS payments,
           (SELECT count(*) FROM delivered_message) AS deliveries"#,
        ))
        .await?
        .expect("rollback result");
    assert_eq!(row.try_get::<i64>("", "transactions")?, 0);
    assert_eq!(row.try_get::<i64>("", "dispatches")?, 0);
    assert_eq!(row.try_get::<i64>("", "payments")?, 0);
    assert_eq!(row.try_get::<i64>("", "deliveries")?, 0);

    // Re-inclusion of the same transaction must attach to its replacement block.
    let replacement = Header {
        hash: ethers::types::H256::repeat_byte(3),
        ..block
    };
    store
        .observe(
            &store.state().await?.expect("initialized"),
            &anchor,
            &replacement,
        )
        .await?;
    store
        .append(
            &store.state().await?.expect("initialized"),
            &[(
                replacement.clone(),
                [event, gas, delivery]
                    .into_iter()
                    .map(|event| Event {
                        block_hash: replacement.hash,
                        ..event
                    })
                    .collect(),
            )],
        )
        .await?;
    for stream in ReceiptStream::ALL {
        let mut after = 0;
        assert_eq!(
            enrich_page(
                &enrichment_store,
                stream,
                &mut after,
                RECEIPT_TIMEOUT,
                &permits
            )
            .await,
            PageOutcome::Idle
        );
        assert!(enrichment_store
            .db
            .pending_receipts(1, stream, 0)
            .await?
            .is_empty());
    }
    assert_eq!(calls.load(Ordering::Relaxed), 3);
    let row = store.db.query_one(Statement::from_string(DbBackend::Postgres,
        r#"SELECT encode(b.hash,'hex') AS hash FROM "transaction" t JOIN block b ON b.id=t.block_id"#,
    )).await?.expect("replacement transaction");
    assert_eq!(row.try_get::<String>("", "hash")?, "03".repeat(32));
    Ok(())
}

#[tokio::test]
async fn cached_backlog_drains_while_other_stream_receipt_is_pending() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let db = Database::connect(&url).await?;
    migration::Migrator::up(&db, None).await?;
    db.execute_unprepared(
        r#"
        INSERT INTO block(domain,hash,height,timestamp)
        VALUES(1,decode(repeat('11',32),'hex'),1,now());
        INSERT INTO "transaction"(hash,block_id,gas_limit,nonce,sender,gas_used,cumulative_gas_used)
        SELECT decode(lpad(to_hex(n),64,'0'),'hex'),b.id,0,0,decode(repeat('22',20),'hex'),0,0
        FROM block b CROSS JOIN generate_series(1,205) n;
        INSERT INTO gas_payment(domain,msg_id,payment,gas_amount,log_index,origin,destination,
                                interchain_gas_paymaster,block_hash,block_number,transaction_hash)
        SELECT 1,t.hash,1,1,t.id,1,1,decode(repeat('33',20),'hex'),b.hash,b.height,t.hash
        FROM "transaction" t JOIN block b ON b.id=t.block_id;
        INSERT INTO delivered_message(domain,msg_id,destination_mailbox,block_hash,block_number,transaction_hash)
        SELECT 1,decode(repeat('ff',32),'hex'),decode(repeat('33',20),'hex'),hash,height,
               decode(repeat('ff',32),'hex') FROM block;
        UPDATE delivered_message SET time_created=(now() AT TIME ZONE 'UTC')-interval '2 minutes';
        UPDATE gas_payment SET time_created=(now() AT TIME ZONE 'UTC')-interval '2 minutes';
        "#,
    )
    .await?;
    let calls = Arc::new(AtomicUsize::new(0));
    let domain: HyperlaneDomain = KnownHyperlaneDomain::Ethereum.into();
    let store = HyperlaneDbStore::new(
        crate::db::ScraperDb::with_connection(Database::connect(&url).await?),
        domain.clone(),
        hyperlane_base::settings::CoreContractAddresses::default(),
        Arc::new(PendingProvider {
            domain,
            calls: calls.clone(),
            gate: None,
        }),
    );
    let oldest_pending_seconds = GaugeVec::new(
        prometheus::Opts::new(
            "receipt_oldest_pending_seconds",
            "Oldest pending receipt age",
        ),
        &["chain", "event_type"],
    )?;
    update_pending_age(&store, &oldest_pending_seconds).await?;
    for event_type in ["delivery", "gas_payment"] {
        assert!(
            oldest_pending_seconds
                .with_label_values(&[store.domain.name(), event_type])
                .get()
                >= 120.0
        );
    }
    let worker_store = store.clone();
    let worker_metric = oldest_pending_seconds.clone();
    let (_sender, wakeup) = watch::channel(());
    // A full successful page must not wait for this deliberately long poll interval.
    let worker = tokio::spawn(async move {
        run(
            &worker_store,
            Duration::from_secs(60),
            &worker_metric,
            wakeup,
        )
        .await
    });
    let drained = timeout(Duration::from_secs(5), async {
        loop {
            let row = db
                .query_one(Statement::from_string(
                    DbBackend::Postgres,
                    "SELECT count(*) AS pending FROM gas_payment WHERE tx_id IS NULL",
                ))
                .await?
                .ok_or_else(|| eyre::eyre!("Missing pending count"))?;
            if row.try_get::<i64>("", "pending")? == 0 {
                return Ok::<_, eyre::Report>(());
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    worker.abort();
    let _ = worker.await;
    drained??;
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    update_pending_age(&store, &oldest_pending_seconds).await?;
    assert_eq!(
        oldest_pending_seconds
            .with_label_values(&[store.domain.name(), "gas_payment"])
            .get(),
        0.0
    );
    assert!(
        oldest_pending_seconds
            .with_label_values(&[store.domain.name(), "delivery"])
            .get()
            >= 120.0
    );

    // A timed-out page advances its cursor, then an exhausted page wraps without
    // asking for immediate catch-up. Retrying poison rows therefore waits.
    let mut after = 0;
    let domain_rpc_permits = Semaphore::new(RECEIPT_RPC_DOMAIN_CONCURRENCY);
    assert_eq!(
        enrich_page(
            &store,
            ReceiptStream::Delivery,
            &mut after,
            Duration::from_millis(50),
            &domain_rpc_permits,
        )
        .await,
        PageOutcome::Retry
    );
    assert!(after > 0);
    assert_eq!(
        enrich_page(
            &store,
            ReceiptStream::Delivery,
            &mut after,
            Duration::from_millis(50),
            &domain_rpc_permits,
        )
        .await,
        PageOutcome::Idle
    );
    assert_eq!(after, 0);
    assert_eq!(calls.load(Ordering::Relaxed), 2);

    // Also retain a newly fetched (not cached) success when its page neighbor
    // remains pending beyond the page deadline.
    db.execute_unprepared(
        r#"INSERT INTO delivered_message(domain,msg_id,destination_mailbox,block_hash,block_number,transaction_hash)
        SELECT 1,decode(lpad(to_hex(206),64,'0'),'hex'),decode(repeat('33',20),'hex'),hash,height,
               decode(lpad(to_hex(206),64,'0'),'hex') FROM block"#,
    )
    .await?;
    assert_eq!(
        enrich_page(
            &store,
            ReceiptStream::Delivery,
            &mut after,
            Duration::from_millis(200),
            &domain_rpc_permits,
        )
        .await,
        PageOutcome::Retry
    );
    let linked = db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT count(*) AS linked FROM delivered_message WHERE destination_tx_id IS NOT NULL",
        ))
        .await?
        .ok_or_else(|| eyre::eyre!("Missing linked count"))?;
    assert_eq!(linked.try_get::<i64>("", "linked")?, 1);
    assert_eq!(calls.load(Ordering::Relaxed), 4);
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn receipt_wakeups_interrupt_idle_waits_but_preserve_failure_cooldowns() {
    let (wakeup, mut first) = watch::channel(());
    let mut second = first.clone();
    let interval = Duration::from_secs(5);
    let start = tokio::time::Instant::now();
    wakeup.send_replace(());
    PageOutcome::Idle.wait(interval, &mut first).await;
    PageOutcome::Idle.wait(interval, &mut second).await;
    assert_eq!(tokio::time::Instant::now(), start);

    PageOutcome::Idle.wait(interval, &mut first).await;
    assert_eq!(tokio::time::Instant::now(), start + interval);
    wakeup.send_replace(());
    PageOutcome::Retry.wait(interval, &mut first).await;
    assert_eq!(tokio::time::Instant::now(), start + interval + interval);
    PageOutcome::Idle.wait(interval, &mut first).await;
    assert_eq!(tokio::time::Instant::now(), start + interval + interval);
    PageOutcome::More.wait(interval, &mut first).await;
    assert_eq!(tokio::time::Instant::now(), start + interval + interval);
}
