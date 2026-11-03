use std::{collections::BTreeMap, future::Future, time::Duration};

use sea_orm::{DatabaseBackend, MockDatabase, Value};
use tokio::sync::mpsc;

use hyperlane_core::{
    h256_to_bytes, h512_to_bytes, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult,
    HyperlaneChain, TxnInfo, TxnReceiptInfo, U256,
};

use super::*;

const REQUESTS: usize = 20;

#[derive(Clone, Debug)]
struct GatedProvider {
    domain: HyperlaneDomain,
    started: mpsc::UnboundedSender<()>,
    release: Arc<Semaphore>,
}

impl GatedProvider {
    async fn wait(&self) {
        self.started.send(()).expect("valid test data");
        self.release
            .acquire()
            .await
            .expect("valid test data")
            .forget();
    }
}

impl HyperlaneChain for GatedProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait::async_trait]
impl HyperlaneProvider for GatedProvider {
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        self.wait().await;
        if height == 3 {
            return Err(ChainCommunicationError::from_other_str("unavailable block"));
        }
        Ok(BlockInfo {
            hash: H256::from_low_u64_be(if height == 4 { 999 } else { height }),
            number: height,
            timestamp: 1_700_000_000,
        })
    }

    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        self.wait().await;
        if *hash == H512::from_low_u64_be(3) {
            return Err(ChainCommunicationError::from_other_str(
                "unavailable transaction",
            ));
        }
        Ok(TxnInfo {
            hash: if *hash == H512::from_low_u64_be(4) {
                H512::from_low_u64_be(999)
            } else {
                *hash
            },
            gas_limit: U256::one(),
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            gas_price: None,
            nonce: 0,
            sender: H256::zero(),
            recipient: None,
            receipt: Some(TxnReceiptInfo {
                gas_used: U256::one(),
                cumulative_gas_used: U256::one(),
                effective_gas_price: None,
            }),
            raw_input_data: None,
        })
    }

    async fn is_contract(&self, _: &H256) -> ChainResult<bool> {
        Err(ChainCommunicationError::from_other_str("unexpected RPC"))
    }

    async fn get_balance(&self, _: String) -> ChainResult<U256> {
        Err(ChainCommunicationError::from_other_str("unexpected RPC"))
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Err(ChainCommunicationError::from_other_str("unexpected RPC"))
    }
}

// Every RPC waits for a permit. A serial implementation cannot start the full
// window; unbounded fanout queues more than eight start notifications.
async fn complete_bounded<F: Future>(
    work: F,
    started: &mut mpsc::UnboundedReceiver<()>,
    release: &Semaphore,
) -> F::Output {
    tokio::pin!(work);
    let completed_early = tokio::time::timeout(Duration::from_secs(1), async {
        for _ in 0..ENRICHMENT_RPC_CONCURRENCY {
            tokio::select! {
                _ = &mut work => return true,
                event = started.recv() => assert_eq!(event, Some(())),
            }
        }
        false
    })
    .await
    .expect("independent RPCs must start concurrently");
    assert!(
        !completed_early,
        "enrichment completed before RPCs were released"
    );
    assert!(started.try_recv().is_err(), "RPC window must stay bounded");
    // Complete one RPC at a time. Each completion may admit exactly one
    // replacement, including after the initial window has been filled.
    for _ in ENRICHMENT_RPC_CONCURRENCY..REQUESTS {
        release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), async {
            tokio::select! {
                _ = &mut work => panic!("enrichment finished with unreleased RPCs"),
                event = started.recv() => assert_eq!(event, Some(())),
            }
        })
        .await
        .expect("one completed RPC must refill its slot");
        assert!(futures::poll!(&mut work).is_pending());
        assert!(
            started.try_recv().is_err(),
            "refill must not exceed eight in-flight RPCs"
        );
    }
    // Every request has now started; only the final window remains blocked.
    release.add_permits(ENRICHMENT_RPC_CONCURRENCY);
    tokio::time::timeout(Duration::from_secs(1), work)
        .await
        .expect("enrichment should finish after release")
}

fn row(id: u64, hash: Vec<u8>) -> BTreeMap<String, Value> {
    BTreeMap::from([
        (
            "id".to_owned(),
            Value::BigInt(Some(i64::try_from(id).expect("valid test data"))),
        ),
        ("hash".to_owned(), Value::Bytes(Some(Box::new(hash)))),
    ])
}

fn store(
    rows: Vec<BTreeMap<String, Value>>,
) -> (
    HyperlaneDbStore,
    mpsc::UnboundedReceiver<()>,
    Arc<Semaphore>,
) {
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<BTreeMap<String, Value>>::new(), rows])
        .into_connection();
    let (started, receiver) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let domain = HyperlaneDomain::new_test_domain("bounded-enrichment");
    (
        HyperlaneDbStore::new(
            ScraperDb::with_connection(db),
            domain.clone(),
            CoreContractAddresses::default(),
            Arc::new(GatedProvider {
                domain,
                started,
                release: release.clone(),
            }),
        ),
        receiver,
        release,
    )
}

#[tokio::test]
async fn block_enrichment_overlaps_reads_with_a_bounded_window_and_keeps_successes() {
    let successes: Vec<_> = (1..=20).filter(|id| !matches!(*id, 3 | 4)).collect();
    let rows = successes
        .iter()
        .map(|id| row(*id, h256_to_bytes(&H256::from_low_u64_be(*id))))
        .collect();
    let (store, mut started, release) = store(rows);
    let requested = (1..=20).map(|id| BlockId::new(H256::from_low_u64_be(id), id));
    let found: HashMap<_, _> =
        complete_bounded(store.ensure_blocks(requested), &mut started, &release)
            .await
            .expect("valid test data")
            .map(|block| (block.hash, block.id))
            .collect();
    assert_eq!(found.len(), successes.len());
    for id in successes {
        assert_eq!(
            found[&H256::from_low_u64_be(id)],
            i64::try_from(id).expect("valid test data")
        );
    }
    assert_eq!(started.len(), 0);
    let log = store.db.clone_connection().into_transaction_log();
    assert_eq!(log.len(), 2, "one lookup and one batched insert");
    let values = &log[1].statements()[0]
        .values
        .as_ref()
        .expect("valid test data")
        .0;
    for id in [3, 4, 999] {
        let hash = Value::Bytes(Some(Box::new(h256_to_bytes(&H256::from_low_u64_be(id)))));
        assert!(!values.contains(&hash));
    }
}

#[tokio::test]
async fn transaction_enrichment_overlaps_reads_with_a_bounded_window_and_keeps_successes() {
    let successes: Vec<_> = (1..=20).filter(|id| !matches!(*id, 3 | 4)).collect();
    let rows = successes
        .iter()
        .map(|id| row(*id, h512_to_bytes(&H512::from_low_u64_be(*id))))
        .collect();
    let (store, mut started, release) = store(rows);
    let requested = (1..=20).map(|id| {
        (
            H512::from_low_u64_be(id),
            i64::try_from(id).expect("valid test data"),
        )
    });
    let found: HashMap<_, _> =
        complete_bounded(store.ensure_txns(requested), &mut started, &release)
            .await
            .expect("valid test data")
            .collect();
    assert_eq!(found.len(), successes.len());
    for id in successes {
        assert_eq!(
            found[&H512::from_low_u64_be(id)],
            i64::try_from(id).expect("valid test data")
        );
    }
    assert_eq!(started.len(), 0);
    let log = store.db.clone_connection().into_transaction_log();
    assert_eq!(log.len(), 2, "one lookup and one batched insert");
    let values = &log[1].statements()[0]
        .values
        .as_ref()
        .expect("valid test data")
        .0;
    for id in [3, 4, 999] {
        let hash = Value::Bytes(Some(Box::new(h512_to_bytes(&H512::from_low_u64_be(id)))));
        assert!(!values.contains(&hash));
    }
}
