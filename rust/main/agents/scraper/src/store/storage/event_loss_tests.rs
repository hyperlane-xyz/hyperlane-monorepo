//! Events without a durable raw-event queue must not report a partially enriched
//! batch as successfully stored. Raw dispatch reconciliation intentionally keeps
//! using the permissive enrichment method.

use std::sync::atomic::{AtomicU8, Ordering};

use migration::MigratorTrait;
use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use hyperlane_core::{
    ChainCommunicationError, ChainInfo, ChainResult, Delivery, HyperlaneChain, Indexed,
    InterchainGasPayment, KnownHyperlaneDomain, SameChainCcrSwap, TxnInfo, TxnReceiptInfo, U256,
};

use super::*;

#[derive(Clone, Debug)]
struct Provider {
    domain: HyperlaneDomain,
    failure: Arc<AtomicU8>,
}

impl HyperlaneChain for Provider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for Provider {
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let failure = self.failure.load(Ordering::SeqCst);
        if failure == 1 {
            return Err(ChainCommunicationError::from_other_str("block unavailable"));
        }
        Ok(BlockInfo {
            hash: H256::from_low_u64_be(if failure == 3 {
                height.checked_add(10_000).expect("small fixture height")
            } else {
                height
            }),
            number: if failure == 5 {
                height.checked_add(10_000).expect("small fixture height")
            } else {
                height
            },
            timestamp: 1_700_000_000,
        })
    }

    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let failure = self.failure.load(Ordering::SeqCst);
        if failure == 2 {
            return Err(ChainCommunicationError::from_other_str(
                "transaction unavailable",
            ));
        }
        Ok(TxnInfo {
            hash: if failure == 4 {
                H512::repeat_byte(99)
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

async fn build_store(db: ScraperDb, failure: Arc<AtomicU8>) -> Result<HyperlaneDbStore> {
    let domain: HyperlaneDomain = KnownHyperlaneDomain::Ethereum.into();
    HyperlaneDbStore::new(
        db,
        domain.clone(),
        CoreContractAddresses::default(),
        Arc::new(Provider { domain, failure }),
        &IndexSettings::default(),
        None,
    )
    .await
}

fn meta(n: u64) -> LogMeta {
    LogMeta {
        address: H256::zero(),
        block_number: n,
        block_hash: H256::from_low_u64_be(n),
        transaction_id: H512::from_low_u64_be(n),
        transaction_index: 0,
        log_index: U256::zero(),
    }
}

#[derive(Clone, Copy, Debug)]
enum Event {
    Delivery,
    Payment,
    Ccr,
}
impl Event {
    async fn persist(self, store: &HyperlaneDbStore, metas: &[LogMeta]) -> Result<u32> {
        match self {
            Self::Delivery => {
                let logs = metas
                    .iter()
                    .map(|meta| (Indexed::new(meta.block_hash), meta.clone()))
                    .collect::<Vec<_>>();
                HyperlaneLogStore::<Delivery>::store_logs(store, &logs).await
            }
            Self::Payment => {
                let logs = metas
                    .iter()
                    .map(|meta| {
                        (
                            Indexed::new(InterchainGasPayment {
                                message_id: meta.block_hash,
                                destination: store.domain.id(),
                                payment: U256::one(),
                                gas_amount: U256::one(),
                            }),
                            meta.clone(),
                        )
                    })
                    .collect::<Vec<_>>();
                HyperlaneLogStore::<InterchainGasPayment>::store_logs(store, &logs).await
            }
            Self::Ccr => {
                let logs = metas
                    .iter()
                    .map(|meta| {
                        (
                            Indexed::new(SameChainCcrSwap {
                                domain: store.domain.id(),
                                source_router: H256::from_low_u64_be(1),
                                destination_router: H256::from_low_u64_be(2),
                                amount_received: U256::one(),
                                recipient: H256::from_low_u64_be(3),
                            }),
                            meta.clone(),
                        )
                    })
                    .collect::<Vec<_>>();
                HyperlaneLogStore::<SameChainCcrSwap>::store_logs(store, &logs).await
            }
        }
    }

    async fn count(self, db: &ScraperDb) -> Result<i64> {
        let table = match self {
            Self::Delivery => "delivered_message",
            Self::Payment => "gas_payment",
            Self::Ccr => "message",
        };
        let row = db
            .clone_connection()
            .query_one(Statement::from_string(
                DatabaseBackend::Postgres,
                format!("SELECT COUNT(*) AS count FROM {table}"),
            ))
            .await?
            .expect("count row");
        Ok(row.try_get("", "count")?)
    }
}

#[tokio::test]
async fn incomplete_event_batches_fail_and_recover_after_restart() -> Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let url = format!("postgresql://postgres:postgres@127.0.0.1:{port}/postgres");
    let connection = Database::connect(&url).await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let failure = Arc::new(AtomicU8::new(0));
    let mut next = 100;

    for event in [Event::Delivery, Event::Payment, Event::Ccr] {
        // Provider failure and a successful response whose hash cannot be read
        // back must both reject a batch. Include an already persisted sibling.
        for mode in 1..=5 {
            let before = event.count(&db).await?;
            let store = build_store(db.clone(), failure.clone()).await?;
            let logs = [meta(next), meta(next + 1)];
            next += 2;
            event.persist(&store, &logs[..1]).await?;
            assert_eq!(event.count(&db).await?, before + 1);
            failure.store(mode, Ordering::SeqCst);
            let error = event
                .persist(&store, &logs)
                .await
                .expect_err("incomplete enrichment must fail the batch");
            assert!(
                error.to_string().contains("Incomplete event enrichment"),
                "{event:?}: {error:#}"
            );
            assert_eq!(
                event.count(&db).await?,
                before + 1,
                "failed batch must not lose its pending event"
            );
            assert_eq!(store.cursor.height().await, 0);
            drop(store);

            failure.store(0, Ordering::SeqCst);
            let restarted = build_store(db.clone(), failure.clone()).await?;
            assert_eq!(restarted.cursor.height().await, 0);
            event.persist(&restarted, &logs).await?;
            assert_eq!(
                event.count(&db).await?,
                before + 2,
                "recovery stores the missing sibling"
            );
            event.persist(&restarted, &logs).await?;
            assert_eq!(event.count(&db).await?, before + 2, "replay is idempotent");
        }
    }
    Ok(())
}

#[tokio::test]
async fn intentional_zero_transaction_metadata_keeps_existing_handling() -> Result<()> {
    let db = ScraperDb::with_connection(
        sea_orm::MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([
                Vec::<std::collections::BTreeMap<String, sea_orm::Value>>::new(),
            ])
            .into_connection(),
    );
    // Any accidental provider call fails. Both variants need no transaction RPC.
    let store = build_store(db, Arc::new(AtomicU8::new(1))).await?;
    let mut svm = meta(1);
    svm.transaction_id = H512::zero();
    svm.block_hash = H256::zero();
    let cosmos = LogMeta {
        block_hash: H256::from_low_u64_be(1),
        ..svm.clone()
    };
    let txns = store
        .ensure_event_transactions([&svm, &cosmos].into_iter())
        .await?;
    assert!(txns.is_empty());
    assert_eq!(txn_id_for_meta(&txns, &svm), Some(None));
    // Cosmos block-level events still lack a safe payment identity in the SQL
    // schema. Do not turn that separate existing gap into an infinite retry.
    assert_eq!(txn_id_for_meta(&txns, &cosmos), None);
    assert_eq!(store.db.clone_connection().into_transaction_log().len(), 1);
    Ok(())
}

#[derive(Clone, Debug)]
struct DeliveryIndexer(Vec<(Indexed<Delivery>, LogMeta)>);

#[async_trait]
impl hyperlane_core::Indexer<Delivery> for DeliveryIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: std::ops::RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<Delivery>, LogMeta)>> {
        assert_eq!(range, 100..=101, "restart must retry the failed range");
        Ok(self.0.clone())
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(101)
    }
}

#[derive(Clone, Debug)]
struct ObservedStore {
    store: HyperlaneDbStore,
    outcomes: tokio::sync::mpsc::UnboundedSender<bool>,
}

#[async_trait]
impl HyperlaneLogStore<Delivery> for ObservedStore {
    async fn store_logs(&self, logs: &[(Indexed<Delivery>, LogMeta)]) -> Result<u32> {
        let result = HyperlaneLogStore::<Delivery>::store_logs(&self.store, logs).await;
        self.outcomes
            .send(result.is_ok())
            .expect("store outcome receiver");
        result
    }
}

#[derive(Debug)]
struct Cursor {
    checkpoint: Arc<BlockCursor>,
    updated: tokio::sync::mpsc::UnboundedSender<()>,
}

#[async_trait]
impl hyperlane_core::ContractSyncCursor<Delivery> for Cursor {
    async fn next_action(&mut self) -> Result<(hyperlane_core::CursorAction, std::time::Duration)> {
        if self.checkpoint.height().await >= 101 {
            return std::future::pending().await;
        }
        Ok((
            hyperlane_core::CursorAction::Query(100..=101),
            std::time::Duration::ZERO,
        ))
    }

    fn latest_queried_block(&self) -> u32 {
        101
    }

    async fn update(
        &mut self,
        _: Vec<(Indexed<Delivery>, LogMeta)>,
        range: std::ops::RangeInclusive<u32>,
    ) -> Result<()> {
        self.checkpoint.update((*range.end()).into()).await;
        self.checkpoint.flush().await?;
        self.updated.send(()).expect("cursor update receiver");
        Ok(())
    }
}

#[tokio::test]
async fn contract_sync_does_not_checkpoint_failed_enrichment_and_retries_after_restart(
) -> Result<()> {
    use hyperlane_base::{ContractSync, ContractSyncMetrics, CoreMetrics, SyncOptions};
    use std::time::Duration;
    use tokio::time::timeout;

    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let failure = Arc::new(AtomicU8::new(1));
    let logs = [meta(100), meta(101)]
        .into_iter()
        .map(|meta| (Indexed::new(meta.block_hash), meta))
        .collect::<Vec<_>>();
    for fails in [true, false] {
        let store = build_store(db.clone(), failure.clone()).await?;
        let checkpoint = Arc::new(
            db.block_cursor(store.domain.id(), "event_loss_test", 0)
                .await?,
        );
        assert_eq!(
            checkpoint.height().await,
            0,
            "failed range must survive restart"
        );
        let (outcomes, mut results) = tokio::sync::mpsc::unbounded_channel();
        let (updated, mut updates) = tokio::sync::mpsc::unbounded_channel();
        let core_metrics = CoreMetrics::new("event_loss_test", 0, prometheus::Registry::new())?;
        let sync = ContractSync::new(
            store.domain.clone(),
            ObservedStore { store, outcomes },
            DeliveryIndexer(logs.clone()),
            ContractSyncMetrics::new(&core_metrics),
            false,
        );
        let cursor = Cursor {
            checkpoint: checkpoint.clone(),
            updated,
        };
        let task = tokio::spawn(async move {
            sync.sync(
                "message_delivery",
                SyncOptions::new(Some(Box::new(cursor)), None),
            )
            .await
        });
        assert_eq!(
            timeout(Duration::from_secs(30), results.recv()).await?,
            Some(!fails)
        );
        if fails {
            assert!(updates.try_recv().is_err());
            assert_eq!(checkpoint.height().await, 0);
            assert_eq!(Event::Delivery.count(&db).await?, 0);
        } else {
            assert_eq!(
                timeout(Duration::from_secs(30), updates.recv()).await?,
                Some(())
            );
            assert_eq!(checkpoint.height().await, 101);
            assert_eq!(
                db.block_cursor(1, "event_loss_test", 0)
                    .await?
                    .height()
                    .await,
                101
            );
            assert_eq!(Event::Delivery.count(&db).await?, 2);
        }
        task.abort();
        let _ = task.await;
        failure.store(0, Ordering::SeqCst);
    }
    Ok(())
}
