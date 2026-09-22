#![allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]

use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
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

#[test]
fn configuration_is_explicit_and_accepts_flat_loader_values() {
    let config: Config = serde_json::from_value(serde_json::json!({ "fromblock": "10" })).unwrap();
    assert_eq!(config.from_block, 10);
    for invalid in [
        serde_json::json!({}),
        serde_json::json!({"fromBlock": -1}),
        serde_json::json!({"fromBlock": 1, "reorgPeriod": 0}),
    ] {
        assert!(serde_json::from_value::<Config>(invalid).is_err());
    }
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
    db.execute_unprepared("INSERT INTO merkle_tree_insertion(domain,merkle_tree_hook,leaf_index,message_id,block_number) VALUES(1,decode(repeat('09',20),'hex'),0,decode(repeat('09',32),'hex'),0)").await?;
    migration::Migrator::up(&db, None).await?;
    let mut listener = sea_orm::sqlx::postgres::PgListener::connect(&url).await?;
    listener.listen("scraper_event").await?;
    let store = Store { db, domain: 1 };
    assert_eq!(count(&store, "confirmed_merkle_tree_insertion").await?, 1);
    let chain = Chain::new(3);
    let anchor = chain.header(0u64.into()).await?;
    store.initialize(&anchor, &contracts()).await?;
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
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.recv())
            .await
            .is_err(),
        "Provisional events must not notify legacy consumers"
    );
    assert!(
        migration::Migrator::down(&store.db, Some(1)).await.is_err(),
        "Rollback must not expose provisional rows"
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
    assert!(
        store
            .confirm(&before_reorg, &chain.header(2u64.into()).await?)
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
    let mut event_types = std::collections::HashSet::new();
    for _ in 0..4 {
        let notice = tokio::time::timeout(Duration::from_secs(2), listener.recv()).await??;
        let event: serde_json::Value = serde_json::from_str(notice.payload())?;
        event_types.insert(event["eventType"].as_str().unwrap().to_owned());
    }
    assert_eq!(event_types.len(), 4);
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

    assert_eq!(store.prune_headers(0).await?.1, 1);
    assert!(store.hash(1).await?.is_none());
    assert!(store.hash(0).await?.is_some()); // Cutover anchor.
    assert!(store.hash(2).await?.is_some()); // Confirmed boundary.
    assert!(store.hash(3).await?.is_some()); // Unconfirmed suffix.

    // Restart preserves state and invalidates old health. A stale observation
    // cannot release events, and failure to read a finality tag does not release.
    store.initialize(&anchor, &contracts()).await?;
    assert!(store
        .confirm(
            &store.state().await?.unwrap(),
            &chain.header(3u64.into()).await?
        )
        .await
        .is_err());
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
        .confirm(&stale, &chain.header(3u64.into()).await?)
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
    Ok(())
}

#[tokio::test]
async fn header_cleanup_preserves_enrichment_and_bounds_deletes() -> Result<()> {
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
    // Seed historical empty headers to test cleanup of pre-range ingestion data.
    store
        .db
        .execute_unprepared(
            r#"
        INSERT INTO block(domain,height,hash,timestamp)
        SELECT 1,h,decode(lpad(to_hex(h+1),64,'0'),'hex'),now() FROM generate_series(1,9) AS h
        ON CONFLICT DO NOTHING;
    "#,
        )
        .await?;
    // Separate pending event types to exercise each retention condition.
    store.db.execute_unprepared(r#"
        UPDATE gas_payment SET block_number=3, block_hash=(SELECT hash FROM block WHERE domain=1 AND height=3);
        UPDATE delivered_message SET block_number=4, block_hash=(SELECT hash FROM block WHERE domain=1 AND height=4);
        INSERT INTO "transaction"(hash,block_id,gas_limit,nonce,sender,gas_used,cumulative_gas_used)
        SELECT decode(repeat('ee',32),'hex'),id,0,0,decode(repeat('11',20),'hex'),0,0 FROM block WHERE domain=1 AND height=5;
    "#).await?;
    // Enrichment has inserted a transaction but has not committed its event link.
    let enrichment = store.db.begin().await?;
    enrichment.execute_unprepared(r#"
        INSERT INTO "transaction"(hash,block_id,gas_limit,nonce,sender,gas_used,cumulative_gas_used)
        SELECT g.transaction_hash,b.id,0,0,decode(repeat('11',20),'hex'),0,0
        FROM gas_payment g JOIN block b ON b.domain=g.domain AND b.height=g.block_number;
        UPDATE gas_payment SET tx_id=(SELECT id FROM "transaction" WHERE hash=gas_payment.transaction_hash);
    "#).await?;
    assert_eq!(store.prune_headers(0).await?.1, 3); // Empty blocks 1, 6, 7.
    enrichment.commit().await?;
    for height in [0, 2, 3, 4, 5, 8, 9, 10] {
        assert!(
            store.hash(height).await?.is_some(),
            "Missing retained block {height}"
        );
    }
    assert_eq!(store.prune_headers(0).await?.1, 0);
    // A lagging finality tag can point to a header already pruned; no new release.
    chain.fork(1, 1, 0);
    assert_eq!(
        confirm(&chain, &store, &ReorgPeriod::Tag("finalized".into())).await?,
        [0; 4]
    );
    for table in [
        "raw_message_dispatch",
        "gas_payment",
        "delivered_message",
        "merkle_tree_insertion",
    ] {
        assert_eq!(count(&store, table).await?, 1);
    }

    // A backlog is drained across cycles, never one unbounded deletion.
    store.db.execute_unprepared(r#"
        INSERT INTO block(domain,height,hash,timestamp)
        SELECT 1,h,decode(lpad(to_hex(h+10000),64,'0'),'hex'),now() FROM generate_series(11,1110) AS h;
        UPDATE scraper_head SET head_height=1110,indexed_height=1110,confirmed_height=1110,
            indexed_hash=(SELECT hash FROM block WHERE domain=1 AND height=1110);
    "#).await?;
    let (next, deleted) = store.prune_headers(0).await?;
    assert_eq!(deleted, 996); // 1,000 candidates, including four retained headers.
    assert_eq!(store.prune_headers(next).await?.1, 106);
    assert_eq!(store.prune_headers(0).await?.1, 0);
    assert!(store.hash(1110).await?.is_some());
    migration::Migrator::down(&store.db, Some(1)).await?;
    migration::Migrator::up(&store.db, None).await?;
    Ok(())
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
    assert_eq!(count(&store, "block").await?, 3); // Anchor, event block, range end.
    chain.header_calls.store(0, Ordering::Relaxed);
    ingest_head(&chain, &store).await?;
    assert_eq!(chain.header_calls.load(Ordering::Relaxed), 1);
    assert_eq!(chain.ranges.lock().unwrap().len(), 1); // Idle: no log query.

    // Confirmation materializes an exact boundary inside an otherwise empty gap.
    confirm(&chain, &store, &ReorgPeriod::from_blocks(950)).await?;
    assert!(store.hash(50).await?.is_some());
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
    assert_eq!(count(&store, "block").await?, 4); // No headers for 950 empty blocks.
                                                  // Exact confirmed boundary remains the deep-reorg stop, despite sparse headers.
    chain.fork(1000, 40, 20);
    assert!(observe(&chain, &store).await.is_err());
    assert!(store.state().await?.unwrap().halted);
    Ok(())
}
