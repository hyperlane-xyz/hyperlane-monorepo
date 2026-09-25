use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Mutex,
};

use async_trait::async_trait;
use ethers::types::{H160, H256};
use eyre::{ensure, Result};
use hyperlane_base::CoreMetrics;
use hyperlane_core::KnownHyperlaneDomain;
use migration::MigratorTrait;
use sea_orm::{Database, DatabaseConnection};
use testcontainers::{runners::AsyncRunner, ImageExt};
use testcontainers_modules::postgres::Postgres;

use super::*;
use crate::near_head::{
    source::{BlockSelector, Contracts, Event, EventData, Header},
    store::State,
};

struct Chain {
    head: AtomicU64,
    tag: AtomicU64,
    fail_tag: AtomicBool,
    fail_events: AtomicBool,
    wrong_tag: AtomicBool,
    observations: AtomicUsize,
    generic: AtomicBool,
    sequence: AtomicBool,
    publication_tip: AtomicU64,
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
            generic: AtomicBool::new(false),
            sequence: AtomicBool::new(false),
            publication_tip: AtomicU64::new(0),
            events: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl Source for Arc<Chain> {
    async fn header(&self, block: BlockSelector) -> Result<Header> {
        let tagged = matches!(&block, BlockSelector::Safe | BlockSelector::Finalized);
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

    fn has_historical_counts(&self) -> bool {
        !self.generic.load(Ordering::SeqCst)
    }

    fn indexes_by_sequence(&self) -> bool {
        self.sequence.load(Ordering::SeqCst)
    }

    async fn publication_tip(&self) -> Result<Option<u64>> {
        Ok(self
            .generic
            .load(Ordering::SeqCst)
            .then(|| self.publication_tip.load(Ordering::SeqCst)))
    }
}

fn gas_event(height: u64, index: u64) -> Event {
    Event {
        block_number: height,
        block_hash: H256::from_low_u64_be(height.saturating_add(1)),
        tx_hash: Some(H256::from_low_u64_be(index.saturating_add(10_000)).into()),
        tx_index: index,
        log_index: index,
        address: H160::repeat_byte(3).into(),
        sequence: None,
        data: EventData::Gas {
            message_id: H256::from_low_u64_be(index).into(),
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

    assert!(worker.cycle(&mut cache).await?.more);
    let first = worker.store.state().await?.unwrap();
    assert_eq!((first.indexed, first.confirmed), (2, 1));
    assert!(!worker.cycle(&mut cache).await?.more);
    assert_eq!(worker.store.state().await?.unwrap().confirmed, 2);
    Ok(())
}

#[tokio::test]
async fn moving_sequence_tip_publishes_before_the_provisional_cap() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(20_000, false));
    chain.generic.store(true, Ordering::SeqCst);
    chain.sequence.store(true, Ordering::SeqCst);
    chain.publication_tip.store(20_000, Ordering::SeqCst);
    chain.tag.store(20_000, Ordering::SeqCst);
    let worker = worker(db, chain).await?;
    let mut cache = None;

    worker.cycle(&mut cache).await?;
    let state = worker.store.state().await?.unwrap();
    assert_eq!((state.indexed, state.confirmed), (10_000, 10_000));
    worker.cycle(&mut cache).await?;
    let state = worker.store.state().await?.unwrap();
    assert_eq!((state.indexed, state.confirmed), (20_000, 20_000));
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
    // A limited page keeps draining and reports the ingestion failure.
    let outcome = worker.cycle(&mut cache).await?;
    assert!(outcome.more && outcome.ingestion_failed);
    assert_eq!(worker.store.state().await?.unwrap().confirmed, 1);
    // Once the backlog is drained the ingestion error surfaces.
    assert!(worker.cycle(&mut cache).await.is_err());
    assert_eq!(worker.store.state().await?.unwrap().confirmed, 2);
    Ok(())
}

#[tokio::test]
async fn backlog_drains_without_polls_while_ingestion_fails_then_recovers() -> Result<()> {
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
    worker.cycle(&mut None).await?;
    assert_eq!(worker.store.state().await?.unwrap().confirmed, 0);

    // A poll interval far beyond the test timeout: draining both pages proves
    // the limited page did not wait for a poll.
    let worker = Arc::new(Worker {
        poll_interval: Duration::from_secs(3_600),
        ..Arc::into_inner(worker).expect("sole worker handle")
    });
    chain.head.store(3, Ordering::SeqCst);
    chain.tag.store(2, Ordering::SeqCst);
    chain.fail_events.store(true, Ordering::SeqCst);
    let task = tokio::spawn({
        let worker = worker.clone();
        async move { worker.run_cycles().await }
    });
    wait_for(&worker, |state| {
        state.confirmed == 2 && critical(&worker) == 1
    })
    .await?;
    task.abort();
    assert!(task
        .await
        .expect_err("worker runs until aborted")
        .is_cancelled());

    // Critical clears once ingestion recovers.
    let worker = Arc::new(Worker {
        poll_interval: Duration::from_millis(20),
        ..Arc::into_inner(worker).expect("sole worker handle")
    });
    chain.fail_events.store(false, Ordering::SeqCst);
    let task = tokio::spawn({
        let worker = worker.clone();
        async move { worker.run_cycles().await }
    });
    wait_for(&worker, |state| {
        state.indexed == 3 && critical(&worker) == 0
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
async fn finality_tag_on_another_fork_releases_nothing() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(2, false));
    chain.tag.store(1, Ordering::SeqCst);
    chain.events.lock().unwrap().push(gas_event(1, 0));
    let worker = worker(db, chain.clone()).await?;
    let mut cache = None;
    worker.cycle(&mut cache).await?;
    assert_eq!(worker.store.state().await?.unwrap().confirmed, 1);

    chain.head.store(3, Ordering::SeqCst);
    chain.tag.store(2, Ordering::SeqCst);
    chain.wrong_tag.store(true, Ordering::SeqCst);
    chain.events.lock().unwrap().push(gas_event(3, 1));
    let error = worker.cycle(&mut cache).await.unwrap_err();
    assert!(
        format!("{error:#}").contains("Confirmation boundary is on another fork"),
        "unexpected error: {error:#}"
    );
    let state = worker.store.state().await?.unwrap();
    assert_eq!((state.indexed, state.confirmed), (3, 1));
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
    super::super::prepare(
        worker.source.as_ref(),
        &worker.store,
        None,
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
