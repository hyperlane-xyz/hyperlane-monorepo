#![allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]

use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    },
};

use async_trait::async_trait;
use ethers::types::H256;
use hyperlane_core::HyperlaneMessage;
use migration::MigratorTrait;
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement, TransactionTrait};
use testcontainers::{runners::AsyncRunner, ImageExt};
use testcontainers_modules::postgres::Postgres;

use super::*;
use source::{Event, EventData};

struct Chain {
    headers: Mutex<BTreeMap<u64, Header>>,
    fail_logs: Mutex<bool>,
    fail_tag: Mutex<bool>,
    header_calls: AtomicUsize,
    ranges: Mutex<Vec<(u64, u64)>>,
    reorg_during_logs: Mutex<bool>,
    wrong_log_hash: Mutex<bool>,
}

impl Chain {
    fn new(height: u64) -> Self {
        let chain = Self {
            headers: Mutex::new(BTreeMap::new()),
            fail_logs: Mutex::new(false),
            fail_tag: Mutex::new(false),
            header_calls: AtomicUsize::new(0),
            ranges: Mutex::new(Vec::new()),
            reorg_during_logs: Mutex::new(false),
            wrong_log_hash: Mutex::new(false),
        };
        chain.fork(height, 0, 0);
        chain
    }

    fn fork(&self, height: u64, ancestor: u64, fork: u64) {
        let mut headers = self.headers.lock().unwrap();
        headers.retain(|height, _| *height <= ancestor);
        for height in 0..=height {
            if headers.contains_key(&height) {
                continue;
            }
            let parent = headers
                .get(&height.saturating_sub(1))
                .map(|h| h.hash)
                .unwrap_or_default();
            headers.insert(
                height,
                Header {
                    height,
                    timestamp: 1,
                    hash: H256::from_low_u64_be(100 * fork + height + 1),
                    parent,
                },
            );
        }
    }
}

#[async_trait]
impl Source for Chain {
    async fn counts(&self, hash: H256) -> Result<[u32; 2]> {
        let headers = self.headers.lock().unwrap();
        let header = headers
            .values()
            .find(|h| h.hash == hash)
            .ok_or_else(|| eyre::eyre!("Unknown fork"))?;
        Ok([u32::from(header.height >= 2); 2])
    }

    async fn header(&self, block: BlockNumber) -> Result<Header> {
        self.header_calls.fetch_add(1, Ordering::Relaxed);
        let headers = self.headers.lock().unwrap();
        let header = match block {
            BlockNumber::Number(height) => headers.get(&height.as_u64()),
            BlockNumber::Safe | BlockNumber::Finalized => {
                ensure!(!*self.fail_tag.lock().unwrap(), "Tag unavailable");
                headers.last_key_value().map(|(_, header)| header)
            }
            _ => headers.last_key_value().map(|(_, header)| header),
        };
        header.cloned().ok_or_else(|| eyre::eyre!("Missing header"))
    }

    async fn events(&self, from: u64, through: u64) -> Result<Vec<Event>> {
        self.ranges.lock().unwrap().push((from, through));
        ensure!(!*self.fail_logs.lock().unwrap(), "Logs unavailable");
        if *self.reorg_during_logs.lock().unwrap() {
            self.fork(through, from.saturating_sub(1), 10);
        }
        if !(from..=through).contains(&2) {
            return Ok(vec![]);
        }
        let header = self
            .headers
            .lock()
            .unwrap()
            .get(&2)
            .cloned()
            .ok_or_else(|| eyre::eyre!("Missing event fixture header"))?;
        let message = HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: 1,
            destination: 1,
            sender: hyperlane_core::H256::repeat_byte(1),
            recipient: hyperlane_core::H256::repeat_byte(2),
            body: header.hash.as_bytes().to_vec(),
        };
        Ok(vec![
            EventData::Dispatch(message),
            EventData::Delivery(header.hash),
            EventData::Gas {
                message_id: header.hash,
                destination: 1,
                gas: "100".into(),
                payment: "10".into(),
            },
            EventData::Insertion {
                message_id: header.hash,
                index: 0,
            },
        ]
        .into_iter()
        .enumerate()
        .map(|(index, data)| Event {
            block_number: header.height,
            block_hash: if *self.wrong_log_hash.lock().unwrap() {
                H256::repeat_byte(99)
            } else {
                header.hash
            },
            address: H160::repeat_byte(1),
            tx_hash: header.hash,
            tx_index: 0,
            log_index: u64::try_from(index).unwrap(),
            data,
        })
        .collect())
    }
}

fn contracts() -> Contracts {
    Contracts {
        mailbox: H160::repeat_byte(1),
        hook: H160::repeat_byte(1),
        paymaster: H160::repeat_byte(1),
    }
}

/// Model the explicit operator acknowledgement used by legacy cutover fixtures.
async fn seed_verified_cutover(store: &Store, anchor: &Header) -> Result<()> {
    let tx = store.db.begin().await?;
    let contracts = contracts();
    let domain = i32::from_ne_bytes(store.domain.to_ne_bytes());
    let height = i64::try_from(anchor.height)?;
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO block(domain,hash,height,timestamp) VALUES($1,$2,$3,to_timestamp($4::bigint) AT TIME ZONE 'UTC')",
        [domain.into(), anchor.hash.as_bytes().to_vec().into(), height.into(), i64::try_from(anchor.timestamp)?.into()],
    )).await?;
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO scraper_head(domain,start_height,indexed_height,indexed_hash,head_height,confirmed_height,mailbox,merkle_tree_hook,interchain_gas_paymaster) VALUES($1,$2,$2,$3,$2,$2,$4,$5,$6)",
        [domain.into(), height.into(), anchor.hash.as_bytes().to_vec().into(), contracts.mailbox.as_bytes().to_vec().into(), contracts.hook.as_bytes().to_vec().into(), contracts.paymaster.as_bytes().to_vec().into()],
    )).await?;
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO scraper_checkpoint(domain,height,hash,timestamp) VALUES($1,$2,$3,to_timestamp($4::bigint) AT TIME ZONE 'UTC')",
        [domain.into(), height.into(), anchor.hash.as_bytes().to_vec().into(), i64::try_from(anchor.timestamp)?.into()],
    )).await?;
    tx.commit().await?;
    Ok(())
}

async fn ingest_head(chain: &Chain, store: &Store) -> Result<()> {
    let state = observe(chain, store).await?;
    ingest(chain, store, &state, 1000).await?;
    Ok(())
}

async fn count(store: &Store, relation: &str) -> Result<i64> {
    Ok(store
        .db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            format!("SELECT count(*) AS n FROM {relation}"),
        ))
        .await?
        .unwrap()
        .try_get("", "n")?)
}

#[tokio::test]
async fn checkpoint_migration_backfills_an_existing_frontier() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    migration::Migrator::up(&db, None).await?;
    migration::Migrator::down(&db, Some(2)).await?;
    db.execute_unprepared(
        r#"
        INSERT INTO block(domain,height,hash,timestamp) VALUES
          (1,7,decode(repeat('07',32),'hex'),now()),
          (1,8,decode(repeat('08',32),'hex'),now());
        INSERT INTO scraper_head(domain,start_height,indexed_height,indexed_hash,
            head_height,confirmed_height,mailbox,merkle_tree_hook,interchain_gas_paymaster)
        VALUES(1,7,8,decode(repeat('08',32),'hex'),8,7,
            decode(repeat('01',20),'hex'),decode(repeat('02',20),'hex'),decode(repeat('03',20),'hex'));
        "#,
    )
    .await?;
    let error = migration::Migrator::up(&db, None)
        .await
        .expect_err("migration must reject a recently active writer");
    assert!(error.to_string().contains("updated in the last 90 seconds"));
    db.execute_unprepared(
        "UPDATE scraper_head SET updated_at=clock_timestamp()-interval '2 minutes'",
    )
    .await?;
    migration::Migrator::up(&db, None).await?;
    let confirmation_columns = db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT count(*) AS count FROM pg_attribute WHERE attrelid IN ('raw_message_dispatch'::regclass,'delivered_message'::regclass,'gas_payment'::regclass,'merkle_tree_insertion'::regclass) AND attname='confirmed' AND NOT attisdropped".to_owned(),
        ))
        .await?
        .unwrap()
        .try_get::<i64>("", "count")?;
    assert_eq!(confirmation_columns, 0);
    let store = Store { db, domain: 1 };
    assert_eq!(store.checkpoint(7).await?, 7);
    assert_eq!(store.hash(7).await?, Some(H256::repeat_byte(7)));
    assert_eq!(store.hash(8).await?, Some(H256::repeat_byte(8)));
    store
        .db
        .execute_unprepared("DELETE FROM block WHERE domain=1 AND height=8")
        .await?;
    migration::Migrator::down(&store.db, Some(1)).await?;
    let restored_confirmed = store
        .db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT bool_and(confirmed) AS confirmed FROM delivered_message".to_owned(),
        ))
        .await?;
    assert!(restored_confirmed.is_some());
    migration::Migrator::down(&store.db, Some(1)).await?;
    let restored = store
        .db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT hash FROM block WHERE domain=1 AND height=8".to_owned(),
        ))
        .await?
        .expect("down migration restores the indexed checkpoint");
    assert_eq!(restored.try_get::<Vec<u8>>("", "hash")?, vec![8; 32]);
    Ok(())
}

#[tokio::test]
async fn checkpoint_migration_rejects_a_missing_indexed_boundary() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    migration::Migrator::up(&db, None).await?;
    migration::Migrator::down(&db, Some(2)).await?;
    db.execute_unprepared(
        r#"
        INSERT INTO block(domain,height,hash,timestamp)
        VALUES(1,7,decode(repeat('07',32),'hex'),now());
        INSERT INTO scraper_head(domain,start_height,indexed_height,indexed_hash,
            head_height,confirmed_height,mailbox,merkle_tree_hook,interchain_gas_paymaster)
        VALUES(1,7,8,decode(repeat('08',32),'hex'),8,7,
            decode(repeat('01',20),'hex'),decode(repeat('02',20),'hex'),decode(repeat('03',20),'hex'));
        UPDATE scraper_head SET updated_at=clock_timestamp()-interval '2 minutes';
        "#,
    )
    .await?;
    let error = migration::Migrator::up(&db, None)
        .await
        .expect_err("migration must reject a missing indexed checkpoint");
    assert!(error.to_string().contains("indexed near-head checkpoint"));
    db.execute_unprepared(
        "DELETE FROM block WHERE domain=1; INSERT INTO block(domain,height,hash,timestamp) VALUES(1,8,decode(repeat('08',32),'hex'),now())",
    )
    .await?;
    let error = migration::Migrator::up(&db, None)
        .await
        .expect_err("migration must reject a missing confirmed checkpoint");
    assert!(error.to_string().contains("confirmed near-head checkpoint"));
    Ok(())
}

#[tokio::test]
async fn frontier_migration_preserves_legacy_null_heights_and_rolls_back() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    migration::Migrator::up(&db, None).await?;
    migration::Migrator::down(&db, Some(1)).await?;
    db.execute_unprepared(
        r#"
        INSERT INTO scraper_head(domain,start_height,indexed_height,indexed_hash,
          head_height,confirmed_height,mailbox,merkle_tree_hook,interchain_gas_paymaster)
        VALUES(1,0,0,decode(repeat('01',32),'hex'),0,0,
          decode(repeat('01',20),'hex'),decode(repeat('02',20),'hex'),decode(repeat('03',20),'hex'));
        INSERT INTO scraper_checkpoint(domain,height,hash,timestamp)
        VALUES(1,0,decode(repeat('01',32),'hex'),now());
        INSERT INTO delivered_message(domain,destination_mailbox,msg_id,transaction_index,log_index)
        VALUES(1,decode(repeat('01',20),'hex'),decode(repeat('04',32),'hex'),0,0);
        INSERT INTO gas_payment(domain,interchain_gas_paymaster,msg_id,destination,
          gas_amount,payment,origin,transaction_index,log_index)
        VALUES(1,decode(repeat('03',20),'hex'),decode(repeat('04',32),'hex'),2,1,1,1,0,0);
        "#,
    )
    .await?;
    migration::Migrator::up(&db, None).await?;
    for relation in ["confirmed_delivered_message", "confirmed_gas_payment"] {
        assert_eq!(
            db.query_one(Statement::from_string(
                DbBackend::Postgres,
                format!("SELECT count(*) AS n FROM {relation}"),
            ))
            .await?
            .unwrap()
            .try_get::<i64>("", "n")?,
            1
        );
    }
    migration::Migrator::down(&db, Some(1)).await?;
    for relation in ["delivered_message", "gas_payment"] {
        let row = db
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                format!("SELECT confirmed FROM {relation}"),
            ))
            .await?
            .unwrap();
        assert!(row.try_get::<bool>("", "confirmed")?);
    }
    Ok(())
}

#[tokio::test]
async fn postgres_near_head_confirmation_reorg_and_legacy_compatibility() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let db = Database::connect(&url).await?;
    // Seed a legacy row before the migration. Existing IDs, visibility and
    // notifications must survive the additive schema change.
    migration::Migrator::up(&db, Some(14)).await?;
    db.execute_unprepared("CREATE ROLE scraper_notification_reader; CREATE ROLE scraper_writer; GRANT SELECT ON raw_message_dispatch TO scraper_notification_reader; GRANT SELECT,INSERT,UPDATE ON block,raw_message_dispatch,delivered_message,gas_payment,merkle_tree_insertion TO scraper_writer; INSERT INTO merkle_tree_insertion(domain,merkle_tree_hook,leaf_index,message_id,block_number) VALUES(1,decode(repeat('09',20),'hex'),0,decode(repeat('09',32),'hex'),0)").await?;
    migration::Migrator::up(&db, None).await?;
    let permission = db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT has_table_privilege('scraper_notification_reader','scraper_head','SELECT') AS head,has_table_privilege('scraper_notification_reader','confirmed_raw_message_dispatch','SELECT') AS events",
        ))
        .await?
        .unwrap();
    assert!(permission.try_get::<bool>("", "head")?);
    assert!(permission.try_get::<bool>("", "events")?);
    let writer_permission = db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT has_table_privilege('scraper_writer','scraper_head','INSERT') AS head_insert,has_table_privilege('scraper_writer','scraper_head','UPDATE') AS head_update,has_table_privilege('scraper_writer','block','DELETE') AS block_delete,has_table_privilege('scraper_writer','raw_message_dispatch','DELETE') AS event_delete,has_table_privilege('scraper_writer','scraper_checkpoint','SELECT') AS checkpoint_select,has_table_privilege('scraper_writer','scraper_checkpoint','INSERT') AS checkpoint_insert,has_table_privilege('scraper_writer','scraper_checkpoint','DELETE') AS checkpoint_delete,has_table_privilege('scraper_notification_reader','scraper_checkpoint','SELECT') AS reader_checkpoint_select",
        ))
        .await?
        .unwrap();
    for privilege in [
        "head_insert",
        "head_update",
        "block_delete",
        "event_delete",
        "checkpoint_select",
        "checkpoint_insert",
        "checkpoint_delete",
    ] {
        assert!(writer_permission.try_get::<bool>("", privilege)?);
    }
    assert!(!writer_permission.try_get::<bool>("", "reader_checkpoint_select")?);
    let mut listener = sea_orm::sqlx::postgres::PgListener::connect(&url).await?;
    listener.listen("scraper_event").await?;
    let mut head_listener = sea_orm::sqlx::postgres::PgListener::connect(&url).await?;
    head_listener.listen("scraper_head").await?;
    let store = Store { db, domain: 1 };
    assert_eq!(count(&store, "confirmed_merkle_tree_insertion").await?, 1);
    let chain = Chain::new(3);
    let anchor = chain.header(0u64.into()).await?;
    seed_verified_cutover(&store, &anchor).await?;
    store.initialize(&anchor, &contracts()).await?;
    store.claim(Duration::from_secs(60)).await?;
    store
        .db
        .execute_unprepared(
            "UPDATE scraper_head SET writer_id='another-writer',writer_lease_until=clock_timestamp()+interval '1 minute'",
        )
        .await?;
    assert!(store.claim(Duration::from_secs(60)).await.is_err());
    store
        .db
        .execute_unprepared(
            "UPDATE scraper_head SET writer_lease_until=clock_timestamp()-interval '1 second'",
        )
        .await?;
    store.claim(Duration::from_secs(60)).await?;
    ingest_head(&chain, &store).await?;
    assert_eq!(
        store.state().await?.unwrap().indexed,
        3,
        "Empty blocks also advance the durable frontier"
    );
    for table in ["raw_message_dispatch", "delivered_message", "gas_payment"] {
        assert_eq!(count(&store, table).await?, 1);
        assert_eq!(count(&store, &format!("confirmed_{table}")).await?, 0);
    }
    for (expected_kind, expected_height) in
        [("initialized", "0"), ("progress", "0"), ("progress", "3")]
    {
        let notice = tokio::time::timeout(Duration::from_secs(2), head_listener.recv()).await??;
        let head: serde_json::Value = serde_json::from_str(notice.payload())?;
        assert_eq!(head["kind"], expected_kind);
        assert_eq!(head["domain"], 1);
        assert_eq!(head["indexedHeight"], expected_height);
        assert_eq!(head["indexedHash"].as_str().unwrap().len(), 64);
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.recv())
            .await
            .is_err(),
        "Provisional events must not notify legacy consumers"
    );
    assert_eq!(count(&store, "gas_payment_stream_cursor").await?, 0);
    assert_eq!(count(&store, "total_gas_payment").await?, 0);
    confirm(&chain, &store, &ReorgPeriod::from_blocks(2)).await?;
    assert_eq!(store.state().await?.unwrap().confirmed, 1);
    assert_eq!(count(&store, "confirmed_gas_payment").await?, 0);

    // Replace an unpublished block at the same height. No uniqueness changes,
    // stale payloads, duplicate events, or preallocated gas cursors survive.
    let before_reorg = store.state().await?.unwrap();
    chain.fork(3, 1, 1);
    ingest_head(&chain, &store).await?;
    for table in ["raw_message_dispatch", "delivered_message", "gas_payment"] {
        assert_eq!(count(&store, table).await?, 1);
    }
    let mut rollback = None;
    for _ in 0..3 {
        let notice = tokio::time::timeout(Duration::from_secs(2), head_listener.recv()).await??;
        let head: serde_json::Value = serde_json::from_str(notice.payload())?;
        if head["kind"] == "rollback" {
            rollback = Some(head);
        }
    }
    let rollback = rollback.expect("reorg must publish its rollback boundary");
    assert_eq!(rollback["previousIndexedHeight"], "3");
    assert_eq!(rollback["indexedHeight"], "1");
    assert!(
        store
            .confirm(
                &before_reorg,
                &chain.header(2u64.into()).await?,
                MIN_CONFIRMATION_LEASE,
            )
            .await
            .is_err(),
        "Stale fork snapshots cannot confirm replacements"
    );
    let replacement = chain.header(2u64.into()).await?;
    let row = store
        .db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT block_hash FROM gas_payment",
        ))
        .await?
        .unwrap();
    assert_eq!(
        row.try_get::<Vec<u8>>("", "block_hash")?,
        replacement.hash.as_bytes()
    );

    // The head, not new logs, authorizes confirmation. Receipt enrichment is
    // absent here and must not prevent any stream from becoming visible.
    chain.fork(4, 3, 1);
    *chain.fail_logs.lock().unwrap() = true;
    let state = observe(&chain, &store).await?;
    assert!(ingest(&chain, &store, &state, 1000).await.is_err());
    confirm(&chain, &store, &ReorgPeriod::from_blocks(2)).await?;
    for table in ["raw_message_dispatch", "delivered_message", "gas_payment"] {
        assert_eq!(count(&store, &format!("confirmed_{table}")).await?, 1);
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.recv())
            .await
            .is_err(),
        "Frontier confirmation must not emit per-row notifications"
    );
    assert_eq!(count(&store, "confirmed_merkle_tree_insertion").await?, 2);
    assert_eq!(count(&store, "gas_payment_stream_cursor").await?, 1);
    confirm(&chain, &store, &ReorgPeriod::from_blocks(2)).await?;
    assert_eq!(
        count(&store, "gas_payment_stream_cursor").await?,
        1,
        "Confirmation is idempotent"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.recv())
            .await
            .is_err(),
        "Confirmation must notify exactly once"
    );
    assert_eq!(store.unenriched("gas_payment", 0).await?.len(), 1);
    let id = store.unenriched("gas_payment", 0).await?[0].0;
    assert!(store.unenriched("gas_payment", id).await?.is_empty());

    // Batch enrichment must match the transaction's block as well as its hash.
    store
        .db
        .execute_unprepared(
            r#"
        INSERT INTO block(domain,hash,height,timestamp)
        VALUES(1,decode(repeat('aa',32),'hex'),1,now());
        INSERT INTO "transaction"(hash,block_id,gas_limit,nonce,sender,gas_used,cumulative_gas_used)
        SELECT g.transaction_hash,b.id,0,0,decode(repeat('11',20),'hex'),0,0
        FROM gas_payment g JOIN block b ON b.domain=g.domain AND b.height=1;
    "#,
        )
        .await?;
    for table in ["gas_payment", "delivered_message"] {
        store.enrich(table, 0, i64::MAX).await?;
        assert_eq!(store.unenriched(table, 0).await?.len(), 1);
    }
    store
        .db
        .execute_unprepared(
            r#"
        UPDATE "transaction" SET block_id=(SELECT id FROM block WHERE domain=1 AND height=2);
    "#,
        )
        .await?;
    for table in ["gas_payment", "delivered_message"] {
        let id = store.unenriched(table, 0).await?[0].0;
        store.enrich(table, id, id).await?;
        assert_eq!(store.unenriched(table, 0).await?.len(), 1);
        store.enrich(table, 0, id).await?;
        assert!(store.unenriched(table, 0).await?.is_empty());
    }
    assert_eq!(count(&store, "gas_payment_stream_cursor").await?, 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.recv())
            .await
            .is_err()
    );

    // Legacy uniqueness is retained, including for chains not using nearHead.
    store.db.execute_unprepared("INSERT INTO block(domain,hash,height,timestamp) VALUES(10,decode(repeat('77',32),'hex'),100,now()) ON CONFLICT DO NOTHING; INSERT INTO block(domain,hash,height,timestamp) VALUES(10,decode(repeat('88',32),'hex'),100,now()) ON CONFLICT DO NOTHING;").await?;
    let row = store
        .db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT count(*) AS n FROM block WHERE domain=10 AND height=100",
        ))
        .await?
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "n")?, 1);

    assert!(store.hash(1).await?.is_none());
    assert!(store.hash(0).await?.is_none()); // Superseded cutover anchor.
    assert!(store.hash(2).await?.is_some()); // Confirmed boundary.
    assert!(store.hash(3).await?.is_some()); // Unconfirmed suffix.

    // Restart preparation must not disturb a live owner's state. The replacement
    // waits for lease expiry, then observes before it can publish.
    store.db.execute_unprepared("UPDATE scraper_head SET writer_id='live-owner',writer_lease_until=clock_timestamp()+interval '1 minute'").await?;
    store.initialize(&anchor, &contracts()).await?;
    assert!(store
        .confirm(
            &store.state().await?.unwrap(),
            &chain.header(3u64.into()).await?,
            MIN_CONFIRMATION_LEASE,
        )
        .await
        .is_err());
    store
        .db
        .execute_unprepared(
            "UPDATE scraper_head SET writer_lease_until=clock_timestamp()-interval '1 second'",
        )
        .await?;
    store.claim(MIN_CONFIRMATION_LEASE).await?;
    observe(&chain, &store).await?;
    *chain.fail_tag.lock().unwrap() = true;
    assert!(
        confirm(&chain, &store, &ReorgPeriod::Tag("finalized".into()))
            .await
            .is_err()
    );
    assert_eq!(store.state().await?.unwrap().confirmed, 2);
    let auxiliary_db = crate::db::ScraperDb::with_connection(Database::connect(&url).await?);
    assert_eq!(confirmed_height(&auxiliary_db, store.domain).await?, 2);

    // A lower head must invalidate a previously computed confirmation boundary
    // even when the indexed tip is unchanged.
    let stale = store.state().await?.unwrap();
    chain.fork(3, 3, 1);
    observe(&chain, &store).await?;
    assert!(store
        .confirm(
            &stale,
            &chain.header(3u64.into()).await?,
            MIN_CONFIRMATION_LEASE,
        )
        .await
        .is_err());

    // A temporarily lagging RPC pauses publication without claiming that an
    // already-confirmed hash was invalidated.
    chain.fork(1, 1, 1);
    assert!(observe(&chain, &store).await.is_err());
    assert!(!store.state().await?.unwrap().halted);
    chain.fork(3, 1, 1);
    observe(&chain, &store).await?;

    // Never silently retract previously published rows. Persist the halt across
    // restarts until an operator repairs the consumers and database.
    chain.fork(3, 1, 2);
    assert!(observe(&chain, &store).await.is_err());
    assert!(store.state().await?.unwrap().halted);
    assert!(confirmed_height(&auxiliary_db, store.domain).await.is_err());
    store.initialize(&anchor, &contracts()).await?;
    assert!(observe(&chain, &store).await.is_err());
    assert_eq!(count(&store, "confirmed_gas_payment").await?, 1);
    migration::Migrator::down(&store.db, Some(1)).await?;
    migration::Migrator::down(&store.db, Some(1)).await?;
    assert!(
        migration::Migrator::down(&store.db, Some(1)).await.is_err(),
        "Base near-head rollback must not expose provisional or halted history"
    );
    Ok(())
}

#[tokio::test]
async fn confirmation_bounds_temporary_checkpoints_without_scanning_blocks() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let db = Database::connect(&url).await?;
    migration::Migrator::up(&db, None).await?;
    let store = Store { db, domain: 1 };
    let chain = Chain::new(10);
    store
        .initialize(&chain.header(0u64.into()).await?, &contracts())
        .await?;
    ingest_head(&chain, &store).await?;
    confirm(&chain, &store, &ReorgPeriod::from_blocks(2)).await?;
    let state = store.state().await?.unwrap();
    assert_eq!(state.confirmed, 8);
    let row = store.db.query_one(Statement::from_string(DbBackend::Postgres,
        "SELECT count(*) AS n,min(height) AS first,max(height) AS last FROM scraper_checkpoint WHERE domain=1".to_owned())).await?.unwrap();
    assert_eq!(row.try_get::<i64>("", "first")?, 8);
    assert_eq!(row.try_get::<i64>("", "last")?, 10);
    assert!(row.try_get::<i64>("", "n")? <= 3);
    let blocks = count(&store, "block").await?;
    confirm(&chain, &store, &ReorgPeriod::from_blocks(0)).await?;
    assert_eq!(count(&store, "scraper_checkpoint").await?, 1);
    assert_eq!(store.checkpoint(10).await?, 10);
    assert_eq!(count(&store, "block").await?, blocks);
    Ok(())
}

#[tokio::test]
async fn append_refreshes_the_confirmation_lease_after_a_slow_fetch() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    migration::Migrator::up(&db, None).await?;
    let store = Store { db, domain: 1 };
    let chain = Chain::new(1);
    store
        .initialize(&chain.header(0u64.into()).await?, &contracts())
        .await?;
    let observed = observe(&chain, &store).await?;
    store
        .db
        .execute_unprepared(
            "UPDATE scraper_head SET updated_at=clock_timestamp()-interval '61 seconds'",
        )
        .await?;
    store
        .append(&observed, &[(chain.header(1u64.into()).await?, vec![])])
        .await?;
    assert_eq!(confirm(&chain, &store, &ReorgPeriod::None).await?, [0; 4]);
    assert_eq!(store.state().await?.unwrap().confirmed, 1);
    Ok(())
}

#[tokio::test]
async fn finality_tag_ahead_of_observed_head_confirms_observed_history() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let db = Database::connect(&url).await?;
    migration::Migrator::up(&db, None).await?;
    let store = Store { db, domain: 1 };
    let chain = Chain::new(3);
    store
        .initialize(&chain.header(0u64.into()).await?, &contracts())
        .await?;
    ingest_head(&chain, &store).await?;
    // Fast-finality chains can finalize past the head observed moments earlier.
    chain.fork(8, 3, 0);
    store
        .db
        .execute_unprepared(
            "UPDATE scraper_head SET updated_at=clock_timestamp()-interval '45 seconds'",
        )
        .await?;
    let finalized = ReorgPeriod::Tag("finalized".into());
    assert!(
        confirm_leased(&chain, &store, &finalized, Duration::from_secs(30))
            .await
            .is_err(),
        "An expired observation cannot confirm"
    );
    assert_eq!(confirm(&chain, &store, &finalized).await?, [1; 4]);
    let state = store.state().await?.unwrap();
    assert_eq!((state.head, state.confirmed), (3, 3));
    Ok(())
}

#[test]
fn confirmation_lease_outlasts_a_poll() {
    assert_eq!(
        confirmation_lease(Duration::from_millis(20)),
        MIN_CONFIRMATION_LEASE
    );
    assert_eq!(
        confirmation_lease(Duration::from_secs(45)),
        Duration::from_secs(90)
    );
}

#[tokio::test]
async fn ranges_use_sparse_headers_and_reject_fork_changes() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let db = Database::connect(&url).await?;
    migration::Migrator::up(&db, None).await?;
    let store = Store { db, domain: 1 };
    let chain = Chain::new(1000);
    store
        .initialize(&chain.header(0u64.into()).await?, &contracts())
        .await?;
    *chain.wrong_log_hash.lock().unwrap() = true;
    let state = observe(&chain, &store).await?;
    assert!(ingest(&chain, &store, &state, 1000).await.is_err());
    assert_eq!(store.state().await?.unwrap().indexed, 0);
    *chain.wrong_log_hash.lock().unwrap() = false;
    chain.header_calls.store(0, Ordering::Relaxed);
    chain.ranges.lock().unwrap().clear();
    ingest_head(&chain, &store).await?;
    // 1,000 blocks, one event-bearing block: one log range and seven header reads.
    assert_eq!(*chain.ranges.lock().unwrap(), vec![(1, 1000)]);
    assert_eq!(chain.header_calls.load(Ordering::Relaxed), 7);
    assert_eq!(count(&store, "block").await?, 1); // Event blocks only.
    chain.header_calls.store(0, Ordering::Relaxed);
    ingest_head(&chain, &store).await?;
    assert_eq!(chain.header_calls.load(Ordering::Relaxed), 1);
    assert_eq!(chain.ranges.lock().unwrap().len(), 1); // Idle: no log query.

    // Confirmation materializes an exact boundary inside an otherwise empty gap.
    confirm(&chain, &store, &ReorgPeriod::from_blocks(950)).await?;
    assert!(store.hash(50).await?.is_some());
    // A lagging provider above the confirmed frontier must also preserve the suffix.
    chain.fork(900, 900, 0);
    assert!(observe(&chain, &store).await.is_err());
    assert_eq!(store.state().await?.unwrap().indexed, 1000);
    assert!(store.hash(1000).await?.is_some());
    chain.fork(1000, 900, 0);
    observe(&chain, &store).await?;
    chain.fork(1000, 60, 1);
    let state = observe(&chain, &store).await?;
    assert_eq!(state.indexed, 50); // Roll back to a retained, confirmed checkpoint.
    assert!(!state.halted);
    *chain.reorg_during_logs.lock().unwrap() = true;
    assert!(ingest(&chain, &store, &state, 1000).await.is_err());
    assert_eq!(store.state().await?.unwrap().indexed, 50);
    *chain.reorg_during_logs.lock().unwrap() = false;
    chain.header_calls.store(0, Ordering::Relaxed);
    chain.ranges.lock().unwrap().clear();
    ingest_head(&chain, &store).await?;
    assert_eq!(chain.header_calls.load(Ordering::Relaxed), 6);
    assert_eq!(*chain.ranges.lock().unwrap(), vec![(51, 1000)]);
    assert_eq!(count(&store, "block").await?, 1); // Event blocks only.
                                                  // Exact confirmed boundary remains the deep-reorg stop, despite sparse headers.
    chain.fork(1000, 40, 20);
    assert!(observe(&chain, &store).await.is_err());
    assert!(store.state().await?.unwrap().halted);
    Ok(())
}

struct DenseChain {
    chain: Chain,
    omitted: Mutex<Option<(usize, u32)>>,
}

#[async_trait]
impl Source for DenseChain {
    async fn header(&self, number: BlockNumber) -> Result<Header> {
        self.chain.header(number).await
    }

    async fn counts(&self, hash: H256) -> Result<[u32; 2]> {
        Ok(self.chain.counts(hash).await?.map(|count| count * 1001))
    }

    async fn events(&self, from: u64, through: u64) -> Result<Vec<Event>> {
        let mut events = Vec::new();
        for event in self.chain.events(from, through).await? {
            let stream = match event.data {
                EventData::Dispatch(_) => 0,
                EventData::Insertion { .. } => 1,
                _ => {
                    events.push(event);
                    continue;
                }
            };
            for index in 0..1001 {
                if *self.omitted.lock().unwrap() == Some((stream, index)) {
                    continue;
                }
                let mut event = event.clone();
                match &mut event.data {
                    EventData::Dispatch(message) => message.nonce = index,
                    EventData::Insertion {
                        index: leaf,
                        message_id,
                    } => {
                        *leaf = index;
                        *message_id = H256::from_low_u64_be(u64::from(index));
                    }
                    _ => unreachable!(),
                }
                events.push(event);
            }
        }
        for (position, event) in events.iter_mut().enumerate() {
            event.log_index = u64::try_from(position)?;
        }
        Ok(events)
    }
}

#[tokio::test]
async fn incomplete_sequences_retry_after_restart_and_dense_ranges_batch_atomically() -> Result<()>
{
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let db = Database::connect(&url).await?;
    migration::Migrator::up(&db, None).await?;
    let store = Store { db, domain: 1 };
    let source = DenseChain {
        chain: Chain::new(3),
        omitted: Mutex::new(None),
    };
    let anchor = source.header(0u64.into()).await?;
    store.initialize(&anchor, &contracts()).await?;
    for stream in 0..2 {
        for missing in [0, 500, 1000] {
            *source.omitted.lock().unwrap() = Some((stream, missing));
            let state = observe(&source, &store).await?;
            assert!(ingest(&source, &store, &state, 1000).await.is_err());
            assert_eq!(store.state().await?.unwrap().indexed, 0);
            assert_eq!(count(&store, "raw_message_dispatch").await?, 0);
            assert_eq!(
                confirm(&source, &store, &ReorgPeriod::from_blocks(0)).await?,
                [0; 4]
            );
            store.initialize(&anchor, &contracts()).await?;
        }
    }
    *source.omitted.lock().unwrap() = None;
    let state = observe(&source, &store).await?;
    let events = source.events(1, 3).await?;
    // A late duplicate in the second insert chunk rolls back the entire range.
    let header = source.header(2u64.into()).await?;
    let mut invalid = events.clone();
    invalid.push(events[0].clone());
    assert!(store
        .append(&state, &[(header.clone(), invalid)])
        .await
        .is_err());
    assert_eq!(store.state().await?.unwrap().indexed, 0);
    assert_eq!(count(&store, "raw_message_dispatch").await?, 0);
    assert_eq!(count(&store, "block").await?, 0);
    let probe = Database::connect(&url).await?;
    let done = AtomicBool::new(false);
    let (ingestion, lock_probe) = tokio::join!(
        async {
            let start = std::time::Instant::now();
            let result = ingest(&source, &store, &state, 1000).await;
            done.store(true, Ordering::Relaxed);
            (result, start.elapsed())
        },
        async {
            let mut longest = Duration::ZERO;
            while !done.load(Ordering::Relaxed) {
                let tx = probe.begin().await?;
                let start = std::time::Instant::now();
                tx.query_one(Statement::from_string(
                    DbBackend::Postgres,
                    "SELECT domain FROM scraper_head WHERE domain=1 FOR UPDATE",
                ))
                .await?;
                longest = longest.max(start.elapsed());
                tx.rollback().await?;
            }
            Ok::<_, eyre::Report>(longest)
        },
    );
    ingestion.0?;
    eprintln!("2,004-event fixture: ingestion {:?}, max confirmation row-lock acquisition (including round trip) {:?}", ingestion.1, lock_probe?);
    assert_eq!(count(&store, "raw_message_dispatch").await?, 1001);
    assert_eq!(count(&store, "merkle_tree_insertion").await?, 1001);
    assert_eq!(
        confirm(&source, &store, &ReorgPeriod::from_blocks(0)).await?,
        [1001, 1, 1, 1001]
    );
    // The oversized event block publishes atomically; drain its empty trailing span.
    assert_eq!(store.state().await?.unwrap().confirmed, 2);
    assert_eq!(
        confirm(&source, &store, &ReorgPeriod::from_blocks(0)).await?,
        [0; 4]
    );
    assert_eq!(store.state().await?.unwrap().confirmed, 3);
    // Fully published progress needs no finality-tag RPC, even if tags are unavailable.
    *source.chain.fail_tag.lock().unwrap() = true;
    source.chain.header_calls.store(0, Ordering::Relaxed);
    assert_eq!(
        confirm(&source, &store, &ReorgPeriod::Tag("finalized".into())).await?,
        [0; 4]
    );
    assert_eq!(source.chain.header_calls.load(Ordering::Relaxed), 0);
    let index = store
        .db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT indexdef FROM pg_indexes WHERE indexname='gas_payment_block_log'",
        ))
        .await?
        .unwrap();
    assert!(index
        .try_get::<String>("", "indexdef")?
        .contains("WHERE (block_hash IS NOT NULL)"));
    Ok(())
}

#[derive(Clone, Debug)]
struct HungReceiptProvider {
    domain: hyperlane_core::HyperlaneDomain,
    calls: Arc<AtomicUsize>,
}

impl hyperlane_core::HyperlaneChain for HungReceiptProvider {
    fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
        &self.domain
    }
    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl hyperlane_core::HyperlaneProvider for HungReceiptProvider {
    async fn get_block_by_height(
        &self,
        _: u64,
    ) -> hyperlane_core::ChainResult<hyperlane_core::BlockInfo> {
        panic!("block already cached")
    }
    async fn get_txn_by_hash(
        &self,
        _: &hyperlane_core::H512,
    ) -> hyperlane_core::ChainResult<hyperlane_core::TxnInfo> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        std::future::pending().await
    }
    async fn is_contract(&self, _: &hyperlane_core::H256) -> hyperlane_core::ChainResult<bool> {
        panic!("unexpected RPC")
    }
    async fn get_balance(&self, _: String) -> hyperlane_core::ChainResult<hyperlane_core::U256> {
        panic!("unexpected RPC")
    }
    async fn get_chain_metrics(
        &self,
    ) -> hyperlane_core::ChainResult<Option<hyperlane_core::ChainInfo>> {
        panic!("unexpected RPC")
    }
}

#[tokio::test]
async fn receipt_timeouts_do_not_starve_cached_neighbors_across_sweeps() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let db = Database::connect(&url).await?;
    migration::Migrator::up(&db, None).await?;
    let store = Store { db, domain: 1 };
    let chain = Chain::new(3);
    store
        .initialize(&chain.header(0u64.into()).await?, &contracts())
        .await?;
    let state = observe(&chain, &store).await?;
    let mut events = chain.events(1, 3).await?;
    let mut poison = events
        .iter()
        .find(|e| matches!(e.data, EventData::Gas { .. }))
        .unwrap()
        .clone();
    poison.log_index = 99;
    poison.tx_hash = H256::repeat_byte(99);
    events.push(poison);
    store
        .append(&state, &[(chain.header(2u64.into()).await?, events)])
        .await?;
    confirm(&chain, &store, &ReorgPeriod::from_blocks(0)).await?;
    store
        .db
        .execute_unprepared(
            r#"
        INSERT INTO "transaction"(hash,block_id,gas_limit,nonce,sender,gas_used,cumulative_gas_used)
        SELECT g.transaction_hash,b.id,0,0,decode(repeat('11',20),'hex'),0,0
        FROM gas_payment g JOIN block b ON b.hash=g.block_hash WHERE g.log_index<>99;
    "#,
        )
        .await?;
    let calls = Arc::new(AtomicUsize::new(0));
    let domain = hyperlane_core::KnownHyperlaneDomain::Ethereum.into();
    let legacy = HyperlaneDbStore::new(
        crate::db::ScraperDb::with_connection(Database::connect(&url).await?),
        domain,
        hyperlane_base::settings::CoreContractAddresses::default(),
        Arc::new(HungReceiptProvider {
            domain: hyperlane_core::KnownHyperlaneDomain::Ethereum.into(),
            calls: calls.clone(),
        }),
        &hyperlane_base::settings::IndexSettings::default(),
        None,
    )
    .await?;
    let mut cursors = [0; 2];
    for sweep in 1..=2 {
        // Reintroduce an unlinked healthy neighbor on each wrap.
        store
            .db
            .execute_unprepared("UPDATE gas_payment SET tx_id=NULL WHERE log_index<>99")
            .await?;
        enrich_with_timeout(&legacy, &mut cursors, Duration::from_millis(200)).await;
        assert_eq!(calls.load(Ordering::Relaxed), sweep);
        assert_eq!(store.unenriched("gas_payment", 0).await?.len(), 1);
        assert!(store.unenriched("delivered_message", 0).await?.is_empty());
        // Exhausted page resets the cursor, making the poison page eligible again.
        enrich_with_timeout(&legacy, &mut cursors, Duration::from_millis(200)).await;
        assert_eq!(cursors, [0; 2]);
    }
    Ok(())
}

#[test]
fn missing_entire_sequences_and_regressing_counts_are_rejected() {
    assert!(validate_sequences(&[], [4, 5], [4, 5]).is_ok());
    assert!(validate_sequences(&[], [4, 5], [5, 5]).is_err());
    assert!(validate_sequences(&[], [4, 5], [4, 6]).is_err());
    assert!(validate_sequences(&[], [4, 5], [3, 5]).is_err());
}

struct CountedChain {
    chain: Chain,
    calls: Mutex<Vec<H256>>,
    unavailable: Mutex<Option<H256>>,
}

#[async_trait]
impl Source for CountedChain {
    async fn header(&self, block: BlockNumber) -> Result<Header> {
        self.chain.header(block).await
    }
    async fn events(&self, from: u64, through: u64) -> Result<Vec<Event>> {
        self.chain.events(from, through).await
    }
    async fn counts(&self, hash: H256) -> Result<[u32; 2]> {
        self.calls.lock().unwrap().push(hash);
        ensure!(
            *self.unavailable.lock().unwrap() != Some(hash),
            "State unavailable"
        );
        self.chain.counts(hash).await
    }
}

#[tokio::test]
async fn committed_counts_are_reused_but_not_across_reorgs_or_restart() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    migration::Migrator::up(&db, None).await?;
    let store = Store { db, domain: 1 };
    let source = CountedChain {
        chain: Chain::new(3),
        calls: Mutex::new(vec![]),
        unavailable: Mutex::new(None),
    };
    let anchor = source.header(0u64.into()).await?;
    // Unsupported state/tag reads must not leave a new mode persisted.
    *source.unavailable.lock().unwrap() = Some(anchor.hash);
    assert!(prepare(
        &source,
        &store,
        &anchor,
        &contracts(),
        &ReorgPeriod::from_blocks(0)
    )
    .await
    .is_err());
    assert!(store.state().await?.is_none());
    *source.unavailable.lock().unwrap() = None;
    *source.chain.fail_tag.lock().unwrap() = true;
    assert!(prepare(
        &source,
        &store,
        &anchor,
        &contracts(),
        &ReorgPeriod::Tag("safe".into())
    )
    .await
    .is_err());
    assert!(store.state().await?.is_none());
    *source.chain.fail_tag.lock().unwrap() = false;
    prepare(
        &source,
        &store,
        &anchor,
        &contracts(),
        &ReorgPeriod::from_blocks(0),
    )
    .await?;
    source.calls.lock().unwrap().clear();
    let mut cache = None;
    for expected_calls in [2, 3] {
        let state = observe(&source, &store).await?;
        ingest_cached(&source, &store, &state, 1, &mut cache).await?;
        assert_eq!(source.calls.lock().unwrap().len(), expected_calls);
    }
    // Restart preflight uses the retained boundary, even if old anchor state is pruned.
    *source.unavailable.lock().unwrap() = Some(anchor.hash);
    prepare(
        &source,
        &store,
        &anchor,
        &contracts(),
        &ReorgPeriod::from_blocks(0),
    )
    .await?;
    source.calls.lock().unwrap().clear();
    source.chain.fork(3, 1, 10);
    // Orphaned persisted hashes must not prevent startup from reaching rollback.
    prepare(
        &source,
        &store,
        &anchor,
        &contracts(),
        &ReorgPeriod::from_blocks(0),
    )
    .await?;
    source.calls.lock().unwrap().clear();
    let state = observe(&source, &store).await?;
    assert_eq!(state.indexed, 1);
    ingest_cached(&source, &store, &state, 1, &mut cache).await?;
    assert_eq!(source.calls.lock().unwrap().len(), 2);
    // A failed range cannot publish cached counts for an uncommitted boundary.
    let committed = cache;
    *source.chain.fail_logs.lock().unwrap() = true;
    let state = observe(&source, &store).await?;
    assert!(ingest_cached(&source, &store, &state, 1, &mut cache)
        .await
        .is_err());
    assert_eq!(cache, committed);
    *source.chain.fail_logs.lock().unwrap() = false;
    source.calls.lock().unwrap().clear();
    let state = observe(&source, &store).await?;
    ingest_cached(&source, &store, &state, 1, &mut None).await?;
    assert_eq!(source.calls.lock().unwrap().len(), 2);
    Ok(())
}

#[tokio::test]
async fn automatic_cutover_rejects_partial_legacy_history_and_reuses_verified_boundary(
) -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    migration::Migrator::up(&db, None).await?;
    migration::indexes::create_indexes(&db).await?;
    let store = Store { db, domain: 1 };
    // Empty databases start from configured index.from (or block 1 for from=0).
    assert_eq!(store.anchor_height(10).await?, 9);
    assert_eq!(store.anchor_height(0).await?, 0);
    store.db.execute_unprepared("INSERT INTO scraper_checkpoint(domain,height,hash,timestamp) VALUES(1,0,decode(repeat('01',32),'hex'),now())").await?;
    assert!(store.anchor_height(1).await.is_err());
    store
        .db
        .execute_unprepared("DELETE FROM scraper_checkpoint WHERE domain=1")
        .await?;
    let chain = Chain::new(50);
    let header = chain.header(10u64.into()).await?;
    store
        .db
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO block(domain,hash,height,timestamp) VALUES(1,$1,10,now())",
            [header.hash.as_bytes().to_vec().into()],
        ))
        .await?;
    // The shared cursor is deliberately ahead, and another domain has newer history.
    store.db.execute_unprepared("INSERT INTO cursor(domain,event_type,height,time_created) VALUES(1,'',1000,now()); INSERT INTO block(domain,hash,height,timestamp) VALUES(42161,decode(repeat('09',32),'hex'),100,now())").await?;
    assert!(store.anchor_height(1).await.is_err());
    store.db.execute_unprepared("INSERT INTO raw_message_dispatch(msg_id,origin_tx_hash,origin_block_hash,origin_block_height,nonce,origin_domain,destination_domain,sender,recipient,origin_mailbox) VALUES(decode(repeat('03',32),'hex'),decode(repeat('04',32),'hex'),decode(repeat('05',32),'hex'),20,0,1,1,decode(repeat('01',20),'hex'),decode(repeat('02',20),'hex'),decode(repeat('01',20),'hex'))").await?;
    assert!(store.anchor_height(1).await.is_err());
    // Legacy Merkle events need not have a corresponding block-table row.
    store.db.execute_unprepared("INSERT INTO merkle_tree_insertion(domain,merkle_tree_hook,leaf_index,message_id,block_number) VALUES(1,decode(repeat('01',20),'hex'),0,decode(repeat('06',32),'hex'),30)").await?;
    // Dispatch/Merkle maxima and the shared cursor cannot prove the slower
    // gas/delivery streams completed any of these heights.
    assert!(store.anchor_height(1).await.is_err());
    assert!(store.state().await?.is_none());
    // First-start initialization also refuses history appearing after an empty
    // anchor selection, even if its height is below the proposed boundary.
    assert!(store
        .initialize(&chain.header(30u64.into()).await?, &contracts())
        .await
        .is_err());
    assert!(store.state().await?.is_none());
    // An operator-verified cutover explicitly seeds the saved boundary. This
    // fixture models that acknowledgement, not proof of historical completeness.
    let anchor = chain.header(30u64.into()).await?;
    seed_verified_cutover(&store, &anchor).await?;
    prepare(&chain, &store, &anchor, &contracts(), &ReorgPeriod::None).await?;
    store
        .db
        .execute_unprepared("DELETE FROM scraper_checkpoint WHERE domain=1 AND height=30")
        .await?;
    let error = prepare(&chain, &store, &anchor, &contracts(), &ReorgPeriod::None)
        .await
        .expect_err("restart must reject stale checkpoint state");
    assert!(error.to_string().contains("checkpoints are out of sync"));
    store.db.execute_unprepared("INSERT INTO scraper_checkpoint(domain,height,hash,timestamp) VALUES(1,30,decode(repeat('00',31) || '1f','hex'),to_timestamp(1) AT TIME ZONE 'UTC')").await?;
    store.db.execute_unprepared("INSERT INTO scraper_checkpoint(domain,height,hash,timestamp) VALUES(1,31,decode(repeat('00',31) || '20','hex'),to_timestamp(1) AT TIME ZONE 'UTC')").await?;
    let error = prepare(&chain, &store, &anchor, &contracts(), &ReorgPeriod::None)
        .await
        .expect_err("restart must reject checkpoints above indexed progress");
    assert!(error.to_string().contains("checkpoints are out of sync"));
    store
        .db
        .execute_unprepared("DELETE FROM scraper_checkpoint WHERE domain=1 AND height=31")
        .await?;
    // Restart must not choose a new boundary from newer history or a changed default.
    store
        .db
        .execute_unprepared(
            "UPDATE raw_message_dispatch SET origin_block_height=40 WHERE origin_domain=1",
        )
        .await?;
    assert_eq!(store.anchor_height(100).await?, 30);
    prepare(
        &chain,
        &store,
        &chain.header(30u64.into()).await?,
        &contracts(),
        &ReorgPeriod::None,
    )
    .await?;
    assert_eq!(count(&store, "scraper_head").await?, 1);
    Ok(())
}
