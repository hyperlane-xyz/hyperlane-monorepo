use std::{collections::BTreeMap, fmt::Debug, hash::Hash, ops::RangeInclusive};

use migration::MigratorTrait;
use sea_orm::{Database, DatabaseBackend, DbErr, MockDatabase, Value};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use hyperlane_base::{
    ContractSync, ContractSyncMetrics, ContractSyncer, CoreMetrics, WatermarkContractSync,
};
use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, ContractSyncCursor, CursorAction,
    Delivery, HyperlaneChain, HyperlaneDomainProtocol, HyperlaneDomainTechnicalStack,
    HyperlaneDomainType, IndexMode, Indexed, Indexer, InterchainGasPayment, KnownHyperlaneDomain,
    SequenceAwareIndexer, TxnInfo, U256,
};

use super::*;

#[derive(Clone, Debug)]
struct Provider(HyperlaneDomain);
impl HyperlaneChain for Provider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.0
    }
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}
#[async_trait]
impl HyperlaneProvider for Provider {
    async fn get_block_by_height(&self, _: u64) -> ChainResult<BlockInfo> {
        Err(ChainCommunicationError::from_other_str("unexpected RPC"))
    }
    async fn get_txn_by_hash(&self, _: &H512) -> ChainResult<TxnInfo> {
        Err(ChainCommunicationError::from_other_str("unexpected RPC"))
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

async fn build_store(
    db: ScraperDb,
    domain: HyperlaneDomain,
    settings: &IndexSettings,
) -> Result<HyperlaneDbStore> {
    HyperlaneDbStore::new(
        db,
        domain.clone(),
        CoreContractAddresses::default(),
        Arc::new(Provider(domain)),
        settings,
        None,
    )
    .await
}

#[derive(Debug)]
struct IndexerAtTip;
#[async_trait]
impl<T: Send + Sync> Indexer<T> for IndexerAtTip {
    async fn fetch_logs_in_range(
        &self,
        _: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        Ok(vec![])
    }
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(100_000)
    }
}
#[async_trait]
impl<T: Send + Sync> SequenceAwareIndexer<T> for IndexerAtTip {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        Ok((None, 100_000))
    }
}

async fn build_cursor<T>(
    store: &HyperlaneDbStore,
    settings: &IndexSettings,
) -> Result<Box<dyn ContractSyncCursor<T>>>
where
    T: Indexable + Debug + Clone + Eq + Hash + Send + Sync + 'static,
    HyperlaneDbStore: HyperlaneLogStore<T>,
{
    let core = CoreMetrics::new("watermark_test", 0, prometheus::Registry::new())?;
    let sync: WatermarkContractSync<T> = ContractSync::new(
        store.domain.clone(),
        Arc::new(store.clone()),
        Arc::new(IndexerAtTip),
        ContractSyncMetrics::new(&core),
        false,
    );
    sync.cursor(settings.clone()).await
}

async fn next_range<T: 'static>(
    cursor: &mut Box<dyn ContractSyncCursor<T>>,
) -> Result<RangeInclusive<u32>> {
    match cursor.next_action().await?.0 {
        CursorAction::Query(range) => Ok(range),
        action => eyre::bail!("expected query, got {action:?}"),
    }
}

async fn advance<T: 'static>(
    cursor: &mut Box<dyn ContractSyncCursor<T>>,
    chunks: usize,
) -> Result<()> {
    for _ in 0..chunks {
        let range = next_range(cursor).await?;
        cursor.update(vec![], range).await?;
    }
    Ok(())
}

#[tokio::test]
async fn event_watermarks_backfill_legacy_history_and_resume_independently() -> Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let domain: HyperlaneDomain = KnownHyperlaneDomain::Ethereum.into();
    let settings = IndexSettings {
        from: 100,
        chunk_size: 9,
        ..Default::default()
    };
    let common = build_store(db.clone(), domain.clone(), &settings).await?;
    common.cursor.update(50_000).await?;
    common.cursor.flush().await?;
    let ccr = db.block_cursor(1, "ccr_swap", 60_000).await?;
    ccr.flush().await?;

    let delivery = common
        .clone()
        .with_event_watermark::<Delivery>(&settings)
        .await?;
    let mut delivery_cursor = build_cursor::<Delivery>(&delivery, &settings).await?;
    assert_eq!(next_range(&mut delivery_cursor).await?, 100..=109);
    advance(&mut delivery_cursor, 20).await?;
    delivery.cursor.flush().await?;
    let delivery_height = delivery.cursor.height().await;

    // A partially migrated database must resume the existing stream, but must
    // never seed a newly initialized stream from it or from the legacy maximum.
    let payment = common
        .clone()
        .with_event_watermark::<InterchainGasPayment>(&settings)
        .await?;
    let mut payment_cursor = build_cursor::<InterchainGasPayment>(&payment, &settings).await?;
    assert_eq!(next_range(&mut payment_cursor).await?, 100..=109);
    advance(&mut payment_cursor, 3).await?;
    payment.cursor.flush().await?;
    let payment_height = payment.cursor.height().await;
    assert!(delivery_height > payment_height + 100);

    // An old writer continuing to advance its own key cannot alter either new
    // event checkpoint (mixed-version deployment still needs operational care).
    common.cursor.update(75_000).await?;
    common.cursor.flush().await?;
    drop((delivery_cursor, payment_cursor, delivery, payment, common));

    let common = build_store(db.clone(), domain, &settings).await?;
    assert_eq!(common.cursor.height().await, 75_000);
    let delivery = common
        .clone()
        .with_event_watermark::<Delivery>(&settings)
        .await?;
    let payment = common
        .with_event_watermark::<InterchainGasPayment>(&settings)
        .await?;
    assert_eq!(delivery.cursor.height().await, delivery_height);
    assert_eq!(payment.cursor.height().await, payment_height);
    let mut delivery_cursor = build_cursor::<Delivery>(&delivery, &settings).await?;
    let mut payment_cursor = build_cursor::<InterchainGasPayment>(&payment, &settings).await?;
    assert_eq!(
        u64::from(*next_range(&mut delivery_cursor).await?.start()),
        delivery_height
    );
    assert_eq!(
        u64::from(*next_range(&mut payment_cursor).await?.start()),
        payment_height
    );
    assert_eq!(
        db.block_cursor(1, "ccr_swap", 0).await?.height().await,
        60_000
    );

    // Reopening a checkpoint and replaying a stale range must not lower it.
    delivery.cursor.update(100).await?;
    delivery.cursor.flush().await?;
    assert_eq!(
        db.block_cursor(1, Delivery::name(), 0)
            .await?
            .height()
            .await,
        delivery_height
    );
    Ok(())
}

#[tokio::test]
async fn sequence_indexers_keep_their_store_and_relative_start_without_watermark_queries(
) -> Result<()> {
    for protocol in [
        HyperlaneDomainProtocol::Sealevel,
        HyperlaneDomainProtocol::Radix,
        HyperlaneDomainProtocol::Aleo,
    ] {
        let db = ScraperDb::with_connection(
            MockDatabase::new(DatabaseBackend::Postgres)
                .append_query_results([Vec::<BTreeMap<String, Value>>::new()])
                .into_connection(),
        );
        let domain = HyperlaneDomain::Unknown {
            domain_id: 13375,
            domain_name: "sequence_test".to_owned(),
            domain_type: HyperlaneDomainType::LocalTestChain,
            domain_protocol: protocol,
            domain_technical_stack: HyperlaneDomainTechnicalStack::Other,
        };
        let settings = IndexSettings {
            from: -5_000,
            mode: IndexMode::Sequence,
            ..Default::default()
        };
        let common = build_store(db, domain, &settings).await?;
        let delivery = common
            .clone()
            .with_event_watermark::<Delivery>(&settings)
            .await?;
        let payment = common
            .clone()
            .with_event_watermark::<InterchainGasPayment>(&settings)
            .await?;
        assert!(Arc::ptr_eq(&common.cursor, &delivery.cursor));
        assert!(Arc::ptr_eq(&common.cursor, &payment.cursor));
        assert_eq!(settings.from, -5_000);
        assert_eq!(common.db.clone_connection().into_transaction_log().len(), 1);
    }
    Ok(())
}

#[tokio::test]
async fn relative_block_start_is_resolved_by_cursor_without_unsigned_wraparound() -> Result<()> {
    let db = ScraperDb::with_connection(
        MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([Vec::<BTreeMap<String, Value>>::new(), vec![]])
            .into_connection(),
    );
    let settings = IndexSettings {
        from: -5_000,
        chunk_size: 9,
        ..Default::default()
    };
    let common = build_store(db, KnownHyperlaneDomain::Ethereum.into(), &settings).await?;
    let delivery = common.with_event_watermark::<Delivery>(&settings).await?;
    let mut cursor = build_cursor::<Delivery>(&delivery, &settings).await?;
    assert_eq!(next_range(&mut cursor).await?, 95_000..=95_009);
    Ok(())
}

#[tokio::test]
async fn first_event_progress_survives_repeated_short_restarts_without_manual_flush() -> Result<()>
{
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let settings = IndexSettings {
        from: 100,
        chunk_size: 9,
        ..Default::default()
    };
    let mut expected_start = 100;
    for _ in 0..3 {
        let common =
            build_store(db.clone(), KnownHyperlaneDomain::Ethereum.into(), &settings).await?;
        let delivery = common.with_event_watermark::<Delivery>(&settings).await?;
        let mut cursor = build_cursor::<Delivery>(&delivery, &settings).await?;
        assert_eq!(*next_range(&mut cursor).await?.start(), expected_start);
        // The cursor retains one range of overlap; its second update is the
        // first checkpoint beyond the restored start. Neither waits ten seconds.
        advance(&mut cursor, 2).await?;
        expected_start = expected_start.checked_add(1).expect("small fixture height");
        drop((cursor, delivery));
        assert_eq!(
            db.block_cursor(1, Delivery::name(), 0)
                .await?
                .height()
                .await,
            u64::from(expected_start)
        );
        assert_eq!(
            db.block_cursor(1, InterchainGasPayment::name(), 100)
                .await?
                .height()
                .await,
            100
        );
    }
    Ok(())
}

#[tokio::test]
async fn failed_first_event_checkpoint_keeps_the_range_retryable() -> Result<()> {
    let db = ScraperDb::with_connection(
        MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([Vec::<BTreeMap<String, Value>>::new(), vec![]])
            .append_query_errors([DbErr::Custom("checkpoint unavailable".to_owned())])
            .append_query_results([vec![BTreeMap::from([(
                "id".to_owned(),
                Value::BigInt(Some(1)),
            )])]])
            .into_connection(),
    );
    let settings = IndexSettings {
        from: 100,
        chunk_size: 9,
        ..Default::default()
    };
    let common = build_store(db, KnownHyperlaneDomain::Ethereum.into(), &settings).await?;
    let delivery = common.with_event_watermark::<Delivery>(&settings).await?;
    let mut cursor = build_cursor::<Delivery>(&delivery, &settings).await?;
    advance(&mut cursor, 1).await?;
    let range = next_range(&mut cursor).await?;
    assert_eq!(range, 110..=119);
    assert!(cursor
        .update(vec![], range.clone())
        .await
        .expect_err("first checkpoint write fails")
        .to_string()
        .contains("checkpoint unavailable"));
    assert_eq!(next_range(&mut cursor).await?, range);
    cursor.update(vec![], range).await?;
    assert_eq!(next_range(&mut cursor).await?, 120..=129);
    Ok(())
}
