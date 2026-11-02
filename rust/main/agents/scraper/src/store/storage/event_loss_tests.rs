//! Events without a durable raw-event queue must not report a partially enriched
//! batch as successfully stored. Raw dispatch reconciliation intentionally keeps
//! using the permissive enrichment method.

use std::sync::atomic::{AtomicU8, Ordering};

use migration::MigratorTrait;
use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain, HyperlaneLogStore,
    Indexed, KnownHyperlaneDomain, SameChainCcrSwap, TxnInfo, TxnReceiptInfo, U256,
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

#[async_trait::async_trait]
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
        if failure == 2 || (failure == 6 && hash.as_bytes()[63] & 1 == 0) {
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
    Ok(HyperlaneDbStore::new(
        db,
        domain.clone(),
        CoreContractAddresses::default(),
        Arc::new(Provider { domain, failure }),
    ))
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

async fn persist_ccr(store: &HyperlaneDbStore, metas: &[LogMeta]) -> Result<u32> {
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

async fn count_swaps(db: &ScraperDb) -> Result<i64> {
    let row = db
        .clone_connection()
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT COUNT(*) AS count FROM message",
        ))
        .await?
        .expect("count row");
    Ok(row.try_get("", "count")?)
}

#[tokio::test]
async fn repeated_rpc_misses_do_not_withhold_resolvable_siblings() -> Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let failure = Arc::new(AtomicU8::new(6));
    let store = build_store(db.clone(), failure.clone()).await?;
    let logs = [meta(600), meta(601)];
    let missing = logs[0].transaction_id;
    let available = logs[1].transaction_id;
    for _ in 0..3 {
        let txns: HashMap<_, _> = store.ensure_blocks_and_txns(logs.iter()).await?.collect();
        assert_eq!(txns.len(), 1);
        assert!(txns.contains_key(&available));
        assert!(!txns.contains_key(&missing));
        assert_eq!(
            db.get_txn_ids([&available, &missing].into_iter()).await?,
            txns
        );
    }
    failure.store(0, Ordering::SeqCst);
    let recovered: HashMap<_, _> = store.ensure_blocks_and_txns(logs.iter()).await?.collect();
    assert!(recovered.contains_key(&available));
    assert!(recovered.contains_key(&missing));
    Ok(())
}

#[tokio::test]
async fn incomplete_ccr_batches_fail_and_recover_after_restart() -> Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let url = format!("postgresql://postgres:postgres@127.0.0.1:{port}/postgres");
    let connection = Database::connect(&url).await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let failure = Arc::new(AtomicU8::new(0));
    let mut next = 100;

    // Provider failure and a successful response whose hash cannot be read
    // back must both reject a batch. Include an already persisted sibling.
    for mode in 1..=5 {
        let before = count_swaps(&db).await?;
        let store = build_store(db.clone(), failure.clone()).await?;
        let logs = [meta(next), meta(next + 1)];
        next += 2;
        persist_ccr(&store, &logs[..1]).await?;
        assert_eq!(count_swaps(&db).await?, before + 1);
        failure.store(mode, Ordering::SeqCst);
        let error = persist_ccr(&store, &logs)
            .await
            .expect_err("incomplete enrichment must fail the batch");
        assert!(
            error.to_string().contains("Incomplete event enrichment"),
            "{error:#}"
        );
        assert_eq!(
            count_swaps(&db).await?,
            before + 1,
            "failed batch must not lose its pending event"
        );

        drop(store);

        failure.store(0, Ordering::SeqCst);
        let restarted = build_store(db.clone(), failure.clone()).await?;

        persist_ccr(&restarted, &logs).await?;
        assert_eq!(
            count_swaps(&db).await?,
            before + 2,
            "recovery stores the missing sibling"
        );
        persist_ccr(&restarted, &logs).await?;
        assert_eq!(count_swaps(&db).await?, before + 2, "replay is idempotent");
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
        .ensure_blocks_and_txns([&svm, &cosmos].into_iter())
        .await?
        .collect();
    ensure_event_enrichment_complete(&txns, [&svm, &cosmos].into_iter())?;
    assert!(txns.is_empty());
    assert_eq!(txn_id_for_meta(&txns, &svm), Some(None));
    // Cosmos block-level events still lack a safe payment identity in the SQL
    // schema. Do not turn that separate existing gap into an infinite retry.
    assert_eq!(txn_id_for_meta(&txns, &cosmos), None);
    assert!(store
        .db
        .clone_connection()
        .into_transaction_log()
        .is_empty());
    Ok(())
}

#[tokio::test]
async fn missing_earlier_ccr_transaction_preserves_nonce_order_after_recovery() -> Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let failure = Arc::new(AtomicU8::new(6));
    let logs = [meta(600), meta(601)];
    let store = build_store(db.clone(), failure.clone()).await?;
    // The earlier transaction is unavailable; the later sibling must not
    // consume nonce 0 while the range is held for retry.
    for _ in 0..3 {
        assert!(persist_ccr(&store, &logs).await.is_err());
        assert_eq!(count_swaps(&db).await?, 0);
    }
    drop(store);
    failure.store(0, Ordering::SeqCst);
    let restarted = build_store(db.clone(), failure).await?;
    for _ in 0..2 {
        persist_ccr(&restarted, &logs).await?;
        let rows = db
            .clone_connection()
            .query_all(Statement::from_string(
                DatabaseBackend::Postgres,
                "SELECT m.nonce, b.height FROM message m
                 JOIN \"transaction\" t ON m.origin_tx_id = t.id
                 JOIN block b ON t.block_id = b.id ORDER BY m.nonce",
            ))
            .await?;
        let nonces_and_heights = rows
            .iter()
            .map(|row| {
                Ok((
                    row.try_get::<i32>("", "nonce")?,
                    row.try_get::<i64>("", "height")?,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        assert_eq!(nonces_and_heights, vec![(0, 600), (1, 601)]);
    }
    Ok(())
}
