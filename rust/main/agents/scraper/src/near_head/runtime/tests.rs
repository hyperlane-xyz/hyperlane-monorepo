use std::sync::atomic::{AtomicU64, AtomicUsize};

use async_trait::async_trait;
use ethers::types::{H160, H256};
use eyre::{ensure, Result};
use hyperlane_base::CoreMetrics;
use hyperlane_core::KnownHyperlaneDomain;
use migration::MigratorTrait;
use sea_orm::{
    ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement, TransactionTrait,
};
use testcontainers::{runners::AsyncRunner, ImageExt};
use testcontainers_modules::postgres::Postgres;

use super::*;
use crate::near_head::{
    source::{BlockSelector, Contracts, Event, Header},
    store::State,
};

struct Chain {
    head: AtomicU64,
    tag: AtomicU64,
    fail_tag: AtomicBool,
    observations: AtomicUsize,
}

impl Chain {
    fn new(head: u64, fail_tag: bool) -> Self {
        Self {
            head: AtomicU64::new(head),
            tag: AtomicU64::new(0),
            fail_tag: AtomicBool::new(fail_tag),
            observations: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl Source for Arc<Chain> {
    async fn header(&self, block: BlockSelector) -> Result<Header> {
        let height = match block {
            BlockSelector::Height(height) => height,
            BlockSelector::Safe | BlockSelector::Finalized => {
                ensure!(!self.fail_tag.load(Ordering::SeqCst), "Tag unavailable");
                self.tag.load(Ordering::SeqCst)
            }
            BlockSelector::Latest => {
                self.observations.fetch_add(1, Ordering::SeqCst);
                self.head.load(Ordering::SeqCst)
            }
        };
        ensure!(height <= self.head.load(Ordering::SeqCst), "Unknown height");
        Ok(Header {
            height,
            timestamp: 1,
            hash: H256::from_low_u64_be(height.saturating_add(1)),
            parent: H256::from_low_u64_be(height),
        })
    }

    async fn events(&self, _: u64, _: u64) -> Result<Vec<Event>> {
        Ok(Vec::new())
    }

    async fn counts(&self, _: H256) -> Result<[u32; 2]> {
        Ok([0; 2])
    }
}

async fn worker(db: DatabaseConnection, source: Arc<Chain>) -> Result<Arc<Worker>> {
    migration::Migrator::up(&db, None).await?;
    let store = Store { db, domain: 1 };
    store
        .initialize(
            &source.header(0u64.into()).await?,
            &Contracts {
                mailbox: H160::repeat_byte(1).into(),
                hook: H160::repeat_byte(2).into(),
                paymaster: H160::repeat_byte(3).into(),
            },
        )
        .await?;
    let metrics = CoreMetrics::new("scraper", 0, prometheus::Registry::new())?;
    Ok(Arc::new(Worker {
        source: Box::new(source),
        store,
        domain: KnownHyperlaneDomain::Ethereum.into(),
        period: ReorgPeriod::Tag("finalized".into()),
        chunk_size: 20_000,
        poll_interval: Duration::from_millis(20),
        chain_metrics: ChainMetrics::new(&metrics)?,
        sync_metrics: Arc::new(ContractSyncMetrics::new(&metrics)),
    }))
}

fn critical(worker: &Worker) -> i64 {
    worker
        .chain_metrics
        .critical_error
        .with_label_values(&[worker.domain.name()])
        .get()
}

async fn wait_for(worker: &Worker, predicate: impl Fn(&State) -> bool) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let state = worker
                .store
                .state()
                .await?
                .ok_or_else(|| eyre::eyre!("Missing worker state"))?;
            if predicate(&state) {
                return Ok::<_, eyre::Report>(());
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await??;
    Ok(())
}

#[tokio::test]
async fn confirmation_errors_survive_healthy_observations_and_recover() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(100, true));
    let worker = worker(db, chain.clone()).await?;
    let task = tokio::spawn({
        let worker = worker.clone();
        async move { worker.run().await }
    });

    wait_for(&worker, |state| {
        state.indexed == 100 && state.confirmed == 0 && critical(&worker) == 1
    })
    .await?;
    // Exercise several successful observations after confirmation has failed.
    // A successful ingestion-side iteration must not clear that error or index more.
    let observations = chain.observations.load(Ordering::SeqCst);
    chain.head.store(200, Ordering::SeqCst);
    wait_for(&worker, |state| {
        state.head == 200
            && chain.observations.load(Ordering::SeqCst) >= observations.saturating_add(3)
    })
    .await?;
    let state = worker.store.state().await?.expect("initialized state");
    assert_eq!((state.indexed, state.confirmed), (100, 0));
    assert_eq!(critical(&worker), 1);

    chain.tag.store(200, Ordering::SeqCst);
    chain.fail_tag.store(false, Ordering::SeqCst);
    wait_for(&worker, |state| {
        state.indexed == 200 && state.confirmed == 200 && critical(&worker) == 0
    })
    .await?;
    task.abort();
    assert!(task
        .await
        .expect_err("worker runs until aborted")
        .is_cancelled());
    Ok(())
}

#[tokio::test]
async fn stationary_finality_tag_bounds_ingestion_then_resumes() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(10_001, false));
    let worker = worker(db, chain.clone()).await?;
    let task = tokio::spawn({
        let worker = worker.clone();
        async move { worker.run().await }
    });

    wait_for(&worker, |state| {
        state.indexed == 10_000 && state.confirmed == 0 && critical(&worker) == 1
    })
    .await?;
    let observations = chain.observations.load(Ordering::SeqCst);
    wait_for(&worker, |_| {
        chain.observations.load(Ordering::SeqCst) >= observations.saturating_add(3)
    })
    .await?;
    let state = worker.store.state().await?.expect("initialized state");
    assert_eq!((state.indexed, state.confirmed), (10_000, 0));
    assert_eq!(critical(&worker), 1);

    // Publishing 100 blocks opens the cap; ingestion can now consume block 10,001
    // without requiring the finality tag to catch all the way up to the head.
    chain.tag.store(100, Ordering::SeqCst);
    wait_for(&worker, |state| {
        state.indexed == 10_001 && state.confirmed == 100 && critical(&worker) == 0
    })
    .await?;
    task.abort();
    assert!(task
        .await
        .expect_err("worker runs until aborted")
        .is_cancelled());
    Ok(())
}

#[tokio::test]
async fn restart_waits_for_an_rpc_behind_saved_progress() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(5, false));
    let worker = worker(db, chain.clone()).await?;
    let state = crate::near_head::observe(&chain, &worker.store).await?;
    crate::near_head::ingest(&chain, &worker.store, &state, 20_000).await?;
    assert_eq!(worker.store.state().await?.unwrap().indexed, 5);

    chain.head.store(3, Ordering::SeqCst);
    let anchor = chain.header(0u64.into()).await?;
    super::super::prepare(
        worker.source.as_ref(),
        &worker.store,
        &anchor,
        &Contracts {
            mailbox: H160::repeat_byte(1).into(),
            hook: H160::repeat_byte(2).into(),
            paymaster: H160::repeat_byte(3).into(),
        },
        &worker.period,
    )
    .await?;
    assert!(crate::near_head::observe(&chain, &worker.store)
        .await
        .is_err());
    chain.head.store(5, Ordering::SeqCst);
    crate::near_head::observe(&chain, &worker.store).await?;
    Ok(())
}

#[tokio::test]
async fn blocked_cleanup_does_not_delay_publication() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let chain = Arc::new(Chain::new(2, false));
    chain.tag.store(2, Ordering::SeqCst);
    let worker = worker(Database::connect(&url).await?, chain.clone()).await?;
    let state = crate::near_head::observe(&chain, &worker.store).await?;
    worker
        .store
        .append(
            &state,
            &[
                (chain.header(1u64.into()).await?, vec![]),
                (chain.header(2u64.into()).await?, vec![]),
            ],
        )
        .await?;
    let state = worker.store.state().await?.expect("initialized");
    worker
        .store
        .confirm(&state, &chain.header(2u64.into()).await?)
        .await?;
    worker
        .store
        .db
        .execute_unprepared(
            r#"
        CREATE FUNCTION block_cleanup_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(424242); RETURN OLD; END $$;
        CREATE TRIGGER block_cleanup_for_test BEFORE DELETE ON block
            FOR EACH ROW EXECUTE FUNCTION block_cleanup_for_test();
    "#,
        )
        .await?;
    let gate_db = Database::connect(&url).await?;
    let gate = gate_db.begin().await?;
    gate.execute_unprepared("SELECT pg_advisory_xact_lock(424242)")
        .await?;
    let task = tokio::spawn({
        let worker = worker.clone();
        async move { worker.run().await }
    });
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let row = worker.store.db.query_one(Statement::from_string(DbBackend::Postgres,
                "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=424242 AND NOT granted) AS waiting".to_owned())).await?.expect("lock query");
            if row.try_get::<bool>("", "waiting")? { return Ok::<_, eyre::Report>(()); }
            sleep(Duration::from_millis(10)).await;
        }
    }).await??;
    // Cleanup is definitely blocked, yet new canonical work must still finish.
    chain.head.store(4, Ordering::SeqCst);
    chain.tag.store(4, Ordering::SeqCst);
    wait_for(&worker, |state| state.confirmed == 4).await?;
    gate.rollback().await?;
    task.abort();
    assert!(task
        .await
        .expect_err("worker runs until aborted")
        .is_cancelled());
    Ok(())
}
