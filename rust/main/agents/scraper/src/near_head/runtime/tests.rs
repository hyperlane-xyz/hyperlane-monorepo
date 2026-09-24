use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Mutex,
};

use async_trait::async_trait;
use ethers::types::{BlockNumber, H160, H256};
use eyre::{ensure, Result};
use hyperlane_base::CoreMetrics;
use hyperlane_core::KnownHyperlaneDomain;
use migration::MigratorTrait;
use sea_orm::{Database, DatabaseConnection};
use testcontainers::{runners::AsyncRunner, ImageExt};
use testcontainers_modules::postgres::Postgres;

use super::*;
use crate::near_head::{
    source::{Contracts, Event, EventData, Header},
    store::State,
};

struct Chain {
    head: AtomicU64,
    tag: AtomicU64,
    fail_tag: AtomicBool,
    fail_events: AtomicBool,
    wrong_tag: AtomicBool,
    observations: AtomicUsize,
    events: Mutex<Vec<Event>>,
}

impl Chain {
    fn new(head: u64, fail_tag: bool) -> Self {
        Self {
            head: AtomicU64::new(head),
            tag: AtomicU64::new(0),
            fail_tag: AtomicBool::new(fail_tag),
            fail_events: AtomicBool::new(false),
            wrong_tag: AtomicBool::new(false),
            observations: AtomicUsize::new(0),
            events: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl Source for Arc<Chain> {
    async fn header(&self, block: BlockNumber) -> Result<Header> {
        let tagged = matches!(&block, BlockNumber::Safe | BlockNumber::Finalized);
        let height = match block {
            BlockNumber::Number(height) => height.as_u64(),
            BlockNumber::Safe | BlockNumber::Finalized => {
                ensure!(!self.fail_tag.load(Ordering::SeqCst), "Tag unavailable");
                self.tag.load(Ordering::SeqCst)
            }
            BlockNumber::Latest => {
                self.observations.fetch_add(1, Ordering::SeqCst);
                self.head.load(Ordering::SeqCst)
            }
            _ => eyre::bail!("Unexpected block selector"),
        };
        ensure!(height <= self.head.load(Ordering::SeqCst), "Unknown height");
        Ok(Header {
            height,
            timestamp: 1,
            hash: if tagged && self.wrong_tag.load(Ordering::SeqCst) {
                H256::repeat_byte(99)
            } else {
                H256::from_low_u64_be(height.saturating_add(1))
            },
            parent: H256::from_low_u64_be(height),
        })
    }

    async fn events(&self, start: u64, end: u64) -> Result<Vec<Event>> {
        ensure!(!self.fail_events.load(Ordering::SeqCst), "Logs unavailable");
        Ok(self
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.block_number >= start && event.block_number <= end)
            .cloned()
            .collect())
    }

    async fn counts(&self, _: H256) -> Result<[u32; 2]> {
        Ok([0; 2])
    }
}

fn gas_event(height: u64, index: u64) -> Event {
    Event {
        block_number: height,
        block_hash: H256::from_low_u64_be(height.saturating_add(1)),
        tx_hash: H256::from_low_u64_be(index.saturating_add(10_000)),
        tx_index: index,
        log_index: index,
        address: H160::repeat_byte(3),
        data: EventData::Gas {
            message_id: H256::from_low_u64_be(index),
            destination: 2,
            gas: "1".into(),
            payment: "1".into(),
        },
    }
}

async fn worker(db: DatabaseConnection, source: Arc<Chain>) -> Result<Arc<Worker>> {
    migration::Migrator::up(&db, None).await?;
    let store = Store { db, domain: 1 };
    store
        .initialize(
            &source.header(0u64.into()).await?,
            &Contracts {
                mailbox: H160::repeat_byte(1),
                hook: H160::repeat_byte(2),
                paymaster: H160::repeat_byte(3),
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

#[tokio::test]
async fn newly_ingested_events_publish_immediately_and_full_pages_keep_draining() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(2, false));
    chain.tag.store(2, Ordering::SeqCst);
    chain.events.lock().unwrap().extend(
        (0..999)
            .map(|index| gas_event(1, index))
            .chain((999..1500).map(|index| gas_event(2, index))),
    );
    let worker = worker(db, chain).await?;
    let mut cache = None;

    assert!(worker.cycle(&mut cache).await?);
    let first = worker.store.state().await?.unwrap();
    assert_eq!((first.indexed, first.confirmed), (2, 1));
    assert!(!worker.cycle(&mut cache).await?);
    assert_eq!(worker.store.state().await?.unwrap().confirmed, 2);
    Ok(())
}

#[tokio::test]
async fn ingestion_errors_do_not_block_existing_publication() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(2, false));
    chain.events.lock().unwrap().extend(
        (0..999)
            .map(|index| gas_event(1, index))
            .chain((999..1500).map(|index| gas_event(2, index))),
    );
    let worker = worker(db, chain.clone()).await?;
    let mut cache = None;
    worker.cycle(&mut cache).await?;
    assert_eq!(worker.store.state().await?.unwrap().confirmed, 0);

    chain.head.store(3, Ordering::SeqCst);
    chain.tag.store(2, Ordering::SeqCst);
    chain.fail_events.store(true, Ordering::SeqCst);
    assert!(worker.cycle(&mut cache).await?);
    assert_eq!(worker.store.state().await?.unwrap().confirmed, 1);
    assert!(worker.cycle(&mut cache).await.is_err());
    assert_eq!(worker.store.state().await?.unwrap().confirmed, 2);
    Ok(())
}

#[tokio::test]
async fn stale_finality_tag_on_another_fork_releases_nothing() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(2, false));
    chain.tag.store(2, Ordering::SeqCst);
    chain.events.lock().unwrap().push(gas_event(1, 0));
    let worker = worker(db, chain.clone()).await?;
    let mut cache = None;
    worker.cycle(&mut cache).await?;
    assert_eq!(worker.store.state().await?.unwrap().confirmed, 2);

    chain.head.store(3, Ordering::SeqCst);
    chain.tag.store(3, Ordering::SeqCst);
    chain.wrong_tag.store(true, Ordering::SeqCst);
    chain.events.lock().unwrap().push(gas_event(3, 1));
    assert!(worker.cycle(&mut cache).await.is_err());
    let state = worker.store.state().await?.unwrap();
    assert_eq!((state.indexed, state.confirmed), (3, 2));
    Ok(())
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
    // Ingestion may advance while the finality tag is unavailable, but the
    // confirmation failure must keep the chain critical.
    let observations = chain.observations.load(Ordering::SeqCst);
    chain.head.store(200, Ordering::SeqCst);
    wait_for(&worker, |state| {
        state.head == 200
            && chain.observations.load(Ordering::SeqCst) >= observations.saturating_add(3)
    })
    .await?;
    let state = worker.store.state().await?.expect("initialized state");
    assert_eq!((state.indexed, state.confirmed), (200, 0));
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
            mailbox: H160::repeat_byte(1),
            hook: H160::repeat_byte(2),
            paymaster: H160::repeat_byte(3),
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
