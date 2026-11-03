#![allow(dead_code)]

use std::{collections::BTreeMap, sync::Arc, time::Instant};

use hyperlane_base::settings::CoreContractAddresses;
use hyperlane_core::{
    h256_to_bytes, h512_to_bytes, BlockId, BlockInfo, ChainInfo, ChainResult, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};
use sea_orm::{DatabaseBackend, MockDatabase, Value};

use crate::db::ScraperDb;

mod before {
    include!(concat!(env!("HOTPATH_SOURCE_DIR"), "/scraper_before.rs"));
}

mod support {
    include!(concat!(env!("HOTPATH_HARNESS_DIR"), "/support.rs"));
}

use support::{Activity, Version};

const RECORDS: u64 = 32;

#[derive(Debug, Clone)]
struct Rpc {
    domain: HyperlaneDomain,
    activity: Arc<Activity>,
    scenario: &'static str,
}

impl Rpc {
    async fn delay(&self, id: u64) {
        let milliseconds = match self.scenario {
            "zero" => 0,
            "straggler" if id % 8 == 0 => 30,
            _ => 5,
        };
        support::delay(milliseconds).await;
    }
}

impl HyperlaneChain for Rpc {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait::async_trait]
impl HyperlaneProvider for Rpc {
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let _active = self.activity.enter();
        self.delay(height).await;
        Ok(BlockInfo {
            hash: H256::from_low_u64_be(height),
            number: height,
            timestamp: 1_700_000_000,
        })
    }

    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let _active = self.activity.enter();
        let id = U256::from_big_endian(&hash.as_bytes()[32..]).as_u64();
        self.delay(id).await;
        Ok(TxnInfo {
            hash: *hash,
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
        unreachable!("not used by benchmark")
    }
    async fn get_balance(&self, _: String) -> ChainResult<U256> {
        unreachable!("not used by benchmark")
    }
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        unreachable!("not used by benchmark")
    }
}

fn database(kind: &str) -> ScraperDb {
    let rows: Vec<_> = (1..=RECORDS)
        .map(|id| {
            let hash = match kind {
                "blocks" => h256_to_bytes(&H256::from_low_u64_be(id)),
                _ => h512_to_bytes(&H512::from_low_u64_be(id)),
            };
            BTreeMap::from([
                (
                    "id".to_owned(),
                    Value::BigInt(Some(i64::try_from(id).expect("row ID"))),
                ),
                ("hash".to_owned(), Value::Bytes(Some(Box::new(hash)))),
            ])
        })
        .collect();
    ScraperDb::with_connection(
        MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([Vec::<BTreeMap<String, Value>>::new(), rows])
            .into_connection(),
    )
}

#[tokio::test]
#[ignore = "controlled performance experiment; run through docs/performance/hot-paths/rust/run.py"]
async fn measure_hot_paths() {
    let warmups = support::parameter("HOTPATH_WARMUP", 5);
    let repetitions = support::parameter("HOTPATH_REPETITIONS", 30);
    for kind in ["blocks", "transactions"] {
        for scenario in ["zero", "uniform", "straggler"] {
            for iteration in 0..warmups.saturating_add(repetitions) {
                for version in support::order(iteration) {
                    let activity = Arc::new(Activity::default());
                    let db = database(kind);
                    let domain = HyperlaneDomain::new_test_domain("synthetic-enrichment-benchmark");
                    let provider: Arc<dyn HyperlaneProvider> = Arc::new(Rpc {
                        domain: domain.clone(),
                        activity: activity.clone(),
                        scenario,
                    });
                    let blocks: Vec<_> = (1..=RECORDS)
                        .map(|id| BlockId::new(H256::from_low_u64_be(id), id))
                        .collect();
                    let txns: Vec<_> = (1..=RECORDS)
                        .map(|id| {
                            (
                                H512::from_low_u64_be(id),
                                i64::try_from(id).expect("block ID"),
                            )
                        })
                        .collect();
                    let (elapsed, count) = match version {
                        Version::Before => {
                            let store = before::HyperlaneDbStore::new(
                                db,
                                domain,
                                CoreContractAddresses::default(),
                                provider,
                            );
                            let start = Instant::now();
                            let count = if kind == "blocks" {
                                store
                                    .ensure_blocks(blocks.into_iter())
                                    .await
                                    .expect("blocks")
                                    .count()
                            } else {
                                store
                                    .ensure_txns(txns.into_iter())
                                    .await
                                    .expect("transactions")
                                    .count()
                            };
                            (start.elapsed(), count)
                        }
                        Version::After => {
                            let store = super::HyperlaneDbStore::new(
                                db,
                                domain,
                                CoreContractAddresses::default(),
                                provider,
                            );
                            let start = Instant::now();
                            let count = if kind == "blocks" {
                                store
                                    .ensure_blocks(blocks.into_iter())
                                    .await
                                    .expect("blocks")
                                    .count()
                            } else {
                                store
                                    .ensure_txns(txns.into_iter())
                                    .await
                                    .expect("transactions")
                                    .count()
                            };
                            (start.elapsed(), count)
                        }
                    };
                    assert_eq!(count, usize::try_from(RECORDS).expect("record count"));
                    assert_eq!(
                        activity.started.load(std::sync::atomic::Ordering::Relaxed),
                        count
                    );
                    assert!(activity.peak.load(std::sync::atomic::Ordering::Relaxed) <= 8);
                    support::record(
                        kind,
                        scenario,
                        version,
                        iteration,
                        iteration < warmups,
                        elapsed,
                        count,
                        &activity,
                    );
                }
            }
        }
    }
}
