#![allow(clippy::panic)] // Unexpected mock RPCs must fail the regression.

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain, HyperlaneProvider,
    KnownHyperlaneDomain, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};
use migration::MigratorTrait;
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
use testcontainers::{runners::AsyncRunner, ImageExt};
use testcontainers_modules::postgres::Postgres;

use super::*;

#[derive(Clone, Debug)]
struct PendingProvider {
    domain: HyperlaneDomain,
    calls: Arc<AtomicUsize>,
}

impl HyperlaneChain for PendingProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for PendingProvider {
    async fn get_block_by_height(&self, _: u64) -> ChainResult<BlockInfo> {
        panic!("confirmed event headers are already stored")
    }
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        if *hash == H512::from(H256::repeat_byte(0xff)) {
            return std::future::pending().await;
        }
        Ok(TxnInfo {
            hash: *hash,
            gas_limit: U256::zero(),
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            gas_price: None,
            nonce: 0,
            sender: H256::repeat_byte(0x22),
            recipient: None,
            receipt: Some(TxnReceiptInfo {
                gas_used: U256::zero(),
                cumulative_gas_used: U256::zero(),
                effective_gas_price: None,
            }),
            raw_input_data: None,
        })
    }
    async fn is_contract(&self, _: &H256) -> ChainResult<bool> {
        panic!("unexpected RPC")
    }
    async fn get_balance(&self, _: String) -> ChainResult<U256> {
        panic!("unexpected RPC")
    }
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        panic!("unexpected RPC")
    }
}

#[tokio::test]
async fn cached_backlog_drains_while_other_stream_receipt_is_pending() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let db = Database::connect(&url).await?;
    migration::Migrator::up(&db, None).await?;
    db.execute_unprepared(
        r#"
        INSERT INTO block(domain,hash,height,timestamp)
        VALUES(1,decode(repeat('11',32),'hex'),1,now());
        INSERT INTO "transaction"(hash,block_id,gas_limit,nonce,sender,gas_used,cumulative_gas_used)
        SELECT decode(lpad(to_hex(n),64,'0'),'hex'),b.id,0,0,decode(repeat('22',20),'hex'),0,0
        FROM block b CROSS JOIN generate_series(1,205) n;
        INSERT INTO gas_payment(domain,msg_id,payment,gas_amount,log_index,origin,destination,
                                interchain_gas_paymaster,block_hash,block_number,transaction_hash)
        SELECT 1,t.hash,1,1,t.id,1,1,decode(repeat('33',20),'hex'),b.hash,b.height,t.hash
        FROM "transaction" t JOIN block b ON b.id=t.block_id;
        INSERT INTO delivered_message(domain,msg_id,destination_mailbox,block_hash,block_number,transaction_hash)
        SELECT 1,decode(repeat('ff',32),'hex'),decode(repeat('33',20),'hex'),hash,height,
               decode(repeat('ff',32),'hex') FROM block;
        UPDATE delivered_message SET time_created=(now() AT TIME ZONE 'UTC')-interval '2 minutes';
        UPDATE gas_payment SET time_created=(now() AT TIME ZONE 'UTC')-interval '2 minutes';
        "#,
    )
    .await?;
    let calls = Arc::new(AtomicUsize::new(0));
    let domain: HyperlaneDomain = KnownHyperlaneDomain::Ethereum.into();
    let legacy = HyperlaneDbStore::new(
        crate::db::ScraperDb::with_connection(Database::connect(&url).await?),
        domain.clone(),
        hyperlane_base::settings::CoreContractAddresses::default(),
        Arc::new(PendingProvider {
            domain,
            calls: calls.clone(),
        }),
        &hyperlane_base::settings::IndexSettings::default(),
        None,
    )
    .await?;
    let oldest_pending_seconds = GaugeVec::new(
        prometheus::Opts::new(
            "receipt_oldest_pending_seconds",
            "Oldest pending receipt age",
        ),
        &["chain", "event_type"],
    )?;
    update_pending_age(&legacy, &oldest_pending_seconds).await?;
    for event_type in ["delivery", "gas_payment"] {
        assert!(
            oldest_pending_seconds
                .with_label_values(&[legacy.domain.name(), event_type])
                .get()
                >= 120.0
        );
    }
    let worker_store = legacy.clone();
    let worker_metric = oldest_pending_seconds.clone();
    // A full successful page must not wait for this deliberately long poll interval.
    let worker =
        tokio::spawn(
            async move { run(&worker_store, Duration::from_secs(60), &worker_metric).await },
        );
    let drained = timeout(Duration::from_secs(5), async {
        loop {
            let row = db
                .query_one(Statement::from_string(
                    DbBackend::Postgres,
                    "SELECT count(*) AS pending FROM gas_payment WHERE tx_id IS NULL",
                ))
                .await?
                .ok_or_else(|| eyre::eyre!("Missing pending count"))?;
            if row.try_get::<i64>("", "pending")? == 0 {
                return Ok::<_, eyre::Report>(());
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    worker.abort();
    let _ = worker.await;
    drained??;
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    update_pending_age(&legacy, &oldest_pending_seconds).await?;
    assert_eq!(
        oldest_pending_seconds
            .with_label_values(&[legacy.domain.name(), "gas_payment"])
            .get(),
        0.0
    );
    assert!(
        oldest_pending_seconds
            .with_label_values(&[legacy.domain.name(), "delivery"])
            .get()
            >= 120.0
    );

    // A timed-out page advances its cursor, then an exhausted page wraps without
    // asking for immediate catch-up. Retrying poison rows therefore waits.
    let mut after = 0;
    let domain_rpc_permits = Semaphore::new(RECEIPT_RPC_DOMAIN_CONCURRENCY);
    assert!(
        !enrich_page(
            &legacy,
            "delivered_message",
            &mut after,
            Duration::from_millis(50),
            &domain_rpc_permits,
        )
        .await
    );
    assert!(after > 0);
    assert!(
        !enrich_page(
            &legacy,
            "delivered_message",
            &mut after,
            Duration::from_millis(50),
            &domain_rpc_permits,
        )
        .await
    );
    assert_eq!(after, 0);
    assert_eq!(calls.load(Ordering::Relaxed), 2);

    // Also retain a newly fetched (not cached) success when its page neighbor
    // remains pending beyond the page deadline.
    db.execute_unprepared(
        r#"INSERT INTO delivered_message(domain,msg_id,destination_mailbox,block_hash,block_number,transaction_hash)
        SELECT 1,decode(lpad(to_hex(206),64,'0'),'hex'),decode(repeat('33',20),'hex'),hash,height,
               decode(lpad(to_hex(206),64,'0'),'hex') FROM block"#,
    )
    .await?;
    assert!(
        !enrich_page(
            &legacy,
            "delivered_message",
            &mut after,
            Duration::from_millis(200),
            &domain_rpc_permits,
        )
        .await
    );
    let linked = db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT count(*) AS linked FROM delivered_message WHERE destination_tx_id IS NOT NULL",
        ))
        .await?
        .ok_or_else(|| eyre::eyre!("Missing linked count"))?;
    assert_eq!(linked.try_get::<i64>("", "linked")?, 1);
    assert_eq!(calls.load(Ordering::Relaxed), 4);
    Ok(())
}
