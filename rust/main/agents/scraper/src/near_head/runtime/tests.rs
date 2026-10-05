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
    source::{BlockSelector, Contracts, Event, EventBatch, EventData, Header},
    store::State,
};

struct Chain {
    head: AtomicU64,
    tag: AtomicU64,
    fail_tag: AtomicBool,
    fail_events: AtomicBool,
    wrong_tag: AtomicBool,
    observations: AtomicUsize,
    fresh_headers: AtomicUsize,
    sequence: AtomicBool,
    historical_counts: AtomicBool,
    indexing_tip: AtomicU64,
    end_counts_at_head: AtomicBool,
    end_counts: Mutex<[Option<u32>; 4]>,
    count_capable: Mutex<[bool; 4]>,
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
            fresh_headers: AtomicUsize::new(0),
            sequence: AtomicBool::new(false),
            historical_counts: AtomicBool::new(true),
            indexing_tip: AtomicU64::new(u64::MAX),
            end_counts_at_head: AtomicBool::new(false),
            end_counts: Mutex::new([None; 4]),
            count_capable: Mutex::new([false; 4]),
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

    async fn fresh_header(&self, block: BlockSelector) -> Result<Header> {
        self.fresh_headers.fetch_add(1, Ordering::SeqCst);
        self.header(block).await
    }

    async fn events_after(&self, start: u64, end: u64, _sequences: [u32; 4]) -> Result<EventBatch> {
        let sequence = self.sequence.load(Ordering::SeqCst);
        let events = self.events(if sequence { 0 } else { start }, end).await?;
        if !sequence {
            let mut end_counts = *self.end_counts.lock().expect("end-count mutex poisoned");
            if self.end_counts_at_head.load(Ordering::SeqCst)
                && end != self.head.load(Ordering::SeqCst)
            {
                end_counts = [None; 4];
            }
            return Ok(EventBatch {
                events,
                indexed_through: None,
                end_counts,
                count_capable: *self
                    .count_capable
                    .lock()
                    .expect("count-capable mutex poisoned"),
            });
        }
        Ok(EventBatch {
            events,
            indexed_through: Some(end),
            end_counts: [None; 4],
            count_capable: [true; 4],
        })
    }

    async fn counts(&self, _: H256) -> Result<[u32; 2]> {
        Ok([0; 2])
    }

    fn has_historical_counts(&self) -> bool {
        self.historical_counts.load(Ordering::SeqCst)
    }

    fn indexes_by_sequence(&self) -> bool {
        self.sequence.load(Ordering::SeqCst)
    }

    async fn indexing_tip(&self) -> Result<Option<u64>> {
        let tip = self.indexing_tip.load(Ordering::SeqCst);
        Ok((tip != u64::MAX).then_some(tip))
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

fn dispatch_event(height: u64, nonce: u32) -> Event {
    Event {
        block_number: height,
        block_hash: H256::from_low_u64_be(height.saturating_add(1)),
        tx_hash: Some(H256::from_low_u64_be(u64::from(nonce).saturating_add(20_000)).into()),
        tx_index: u64::from(nonce),
        log_index: u64::from(nonce),
        address: H160::repeat_byte(1).into(),
        sequence: Some(nonce),
        data: EventData::Dispatch(hyperlane_core::HyperlaneMessage {
            nonce,
            origin: 1,
            destination: 2,
            ..Default::default()
        }),
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

#[tokio::test]
async fn block_mode_ingestion_stops_at_the_common_stream_tip() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(5, false));
    chain.indexing_tip.store(3, Ordering::SeqCst);
    let worker = worker(db, chain.clone()).await?;
    let state = crate::near_head::observe(&chain, &worker.store).await?;
    assert!(crate::near_head::ingest(&chain, &worker.store, &state, 20_000).await?);
    let state = worker.store.state().await?.expect("initialized state");
    assert_eq!((state.indexed, state.head), (3, 5));
    chain.fresh_headers.store(0, Ordering::SeqCst);
    crate::near_head::confirm(&chain, &worker.store, &ReorgPeriod::from_blocks(3)).await?;
    assert_eq!(chain.fresh_headers.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn block_mode_rewinds_a_range_with_a_truncated_sequence_tail() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(5, false));
    chain.historical_counts.store(false, Ordering::SeqCst);
    chain
        .events
        .lock()
        .expect("event mutex poisoned")
        .push(dispatch_event(2, 0));
    *chain.end_counts.lock().expect("end-count mutex poisoned") = [Some(2), None, None, None];
    let worker = worker(db, chain.clone()).await?;
    let state = crate::near_head::observe(&chain, &worker.store).await?;

    let error = crate::near_head::ingest(&chain, &worker.store, &state, 20_000)
        .await
        .expect_err("missing tail event must reject the block range");
    assert!(error
        .to_string()
        .contains("Incomplete block-mode event range"));
    assert_eq!(
        worker
            .store
            .state()
            .await?
            .expect("initialized state")
            .indexed,
        0
    );

    *chain.end_counts.lock().expect("end-count mutex poisoned") = [Some(1), None, None, None];
    crate::near_head::ingest(&chain, &worker.store, &state, 20_000).await?;
    assert_eq!(
        worker
            .store
            .state()
            .await?
            .expect("initialized state")
            .indexed,
        5
    );
    Ok(())
}

#[tokio::test]
async fn block_mode_does_not_publish_an_unverified_counted_stream() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(5, false));
    chain.historical_counts.store(false, Ordering::SeqCst);
    chain.count_capable.lock().unwrap()[0] = true;
    chain.events.lock().unwrap().push(dispatch_event(2, 0));
    let worker = worker(db, chain.clone()).await?;
    let state = crate::near_head::observe(&chain, &worker.store).await?;

    crate::near_head::ingest(&chain, &worker.store, &state, 20_000).await?;
    crate::near_head::confirm(&chain, &worker.store, &ReorgPeriod::from_blocks(0)).await?;

    let state = worker.store.state().await?.expect("initialized state");
    assert_eq!(
        (state.confirmed, state.indexed, state.verified),
        (0, 5, None)
    );
    Ok(())
}

#[tokio::test]
async fn counted_block_mode_reaches_the_only_verifiable_boundary() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(20_000, false));
    chain.tag.store(20_000, Ordering::SeqCst);
    chain.historical_counts.store(false, Ordering::SeqCst);
    chain.count_capable.lock().unwrap()[0] = true;
    chain.end_counts_at_head.store(true, Ordering::SeqCst);
    *chain.end_counts.lock().unwrap() = [Some(1), None, None, None];
    chain.events.lock().unwrap().insert(0, dispatch_event(2, 0));
    let worker = worker(db, chain).await?;
    let mut cache = None;

    for _ in 0..4 {
        worker.cycle(&mut cache).await?;
    }

    let state = worker.store.state().await?.expect("initialized state");
    assert_eq!((state.confirmed, state.indexed), (20_000, 20_000));
    assert_eq!(state.verified, Some(20_000));
    Ok(())
}

#[tokio::test]
async fn block_mode_rewinds_after_a_sequence_gap() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(3, false));
    chain.historical_counts.store(false, Ordering::SeqCst);
    chain
        .events
        .lock()
        .expect("event mutex poisoned")
        .push(dispatch_event(2, 0));
    let worker = worker(db, chain.clone()).await?;
    let state = crate::near_head::observe(&chain, &worker.store).await?;
    crate::near_head::ingest(&chain, &worker.store, &state, 20_000).await?;

    chain.head.store(5, Ordering::SeqCst);
    chain
        .events
        .lock()
        .expect("event mutex poisoned")
        .push(dispatch_event(5, 2));
    let state = crate::near_head::observe(&chain, &worker.store).await?;
    let error = crate::near_head::ingest(&chain, &worker.store, &state, 20_000)
        .await
        .expect_err("a sequence gap must reject the block range");
    assert!(error
        .to_string()
        .contains("Block-mode sequence gap; rewound for retry"));
    assert_eq!(
        worker
            .store
            .state()
            .await?
            .expect("initialized state")
            .indexed,
        0
    );
    Ok(())
}

#[tokio::test]
async fn block_mode_retries_a_gap_entirely_after_confirmation() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(3, false));
    chain.historical_counts.store(false, Ordering::SeqCst);
    chain.count_capable.lock().unwrap()[0] = true;
    *chain.end_counts.lock().unwrap() = [Some(2), None, None, None];
    chain.events.lock().unwrap().push(dispatch_event(3, 1));
    let worker = worker(db, chain.clone()).await?;
    let state = crate::near_head::observe(&chain, &worker.store).await?;

    let error = crate::near_head::ingest(&chain, &worker.store, &state, 20_000)
        .await
        .expect_err("a transient sequence gap must retry");
    assert!(error.to_string().contains("retrying range"));
    assert!(!worker.store.state().await?.unwrap().halted);

    chain.events.lock().unwrap().insert(0, dispatch_event(2, 0));
    crate::near_head::ingest(&chain, &worker.store, &state, 20_000).await?;
    crate::near_head::confirm(&chain, &worker.store, &ReorgPeriod::from_blocks(0)).await?;
    let state = worker.store.state().await?.unwrap();
    assert_eq!((state.confirmed, state.indexed), (3, 3));
    assert!(!state.halted);
    Ok(())
}

#[tokio::test]
async fn block_mode_sequence_gap_in_confirmed_history_halts_the_domain() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    let chain = Arc::new(Chain::new(5, false));
    chain.historical_counts.store(false, Ordering::SeqCst);
    chain
        .events
        .lock()
        .expect("event mutex poisoned")
        .extend([dispatch_event(2, 0), dispatch_event(3, 1)]);
    let worker = worker(db, chain.clone()).await?;
    let state = crate::near_head::observe(&chain, &worker.store).await?;
    crate::near_head::ingest(&chain, &worker.store, &state, 20_000).await?;
    crate::near_head::confirm(&chain, &worker.store, &ReorgPeriod::from_blocks(0)).await?;

    chain.head.store(10, Ordering::SeqCst);
    chain
        .events
        .lock()
        .expect("event mutex poisoned")
        .push(dispatch_event(10, 1));
    let state = crate::near_head::observe(&chain, &worker.store).await?;
    let error = crate::near_head::ingest(&chain, &worker.store, &state, 20_000)
        .await
        .expect_err("a sequence gap below confirmation must halt");
    assert!(error.to_string().contains("operator repair required"));
    assert!(
        worker
            .store
            .state()
            .await?
            .expect("initialized state")
            .halted
    );
    Ok(())
}
