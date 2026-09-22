use super::*;
use async_trait::async_trait;
use ethers::types::H256;
use migration::MigratorTrait;
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
use std::sync::Mutex;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

struct MockSource(Mutex<(u64, u64, bool)>);
#[async_trait]
impl Source for MockSource {
    async fn header(&self, number: BlockNumber) -> Result<Header> {
        let (head, branch, _) = *self.0.lock().expect("mock lock");
        let height = match number {
            BlockNumber::Number(number) => number.as_u64(),
            _ => head,
        };
        Ok(Header {
            height,
            timestamp: height,
            hash: H256::from_low_u64_be(height.saturating_add(branch)),
            parent: H256::from_low_u64_be(height.saturating_sub(1).saturating_add(branch)),
        })
    }
    async fn events(&self, from: u64, through: u64) -> Result<Vec<Event>> {
        let (_, branch, events) = *self.0.lock().expect("mock lock");
        Ok(if events {
            (from..=through)
                .map(|height| Event {
                    block_number: height,
                    block_hash: H256::from_low_u64_be(height.saturating_add(branch)),
                    address: H160::repeat_byte(1),
                    tx_hash: H256::from_low_u64_be(height),
                    tx_index: 0,
                    log_index: 0,
                    data: source::EventData::Delivery(H256::from_low_u64_be(height)),
                })
                .collect()
        } else {
            vec![]
        })
    }
}
struct FailedLogs<'a>(&'a MockSource);
#[async_trait]
impl Source for FailedLogs<'_> {
    async fn header(&self, number: BlockNumber) -> Result<Header> {
        self.0.header(number).await
    }
    async fn events(&self, _from: u64, _through: u64) -> Result<Vec<Event>> {
        eyre::bail!("injected log outage")
    }
}

async fn scalar(store: &Store, query: &str) -> Result<i64> {
    Ok(store
        .db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            query.to_owned(),
        ))
        .await?
        .expect("query row")
        .try_get("", "n")?)
}

#[tokio::test]
async fn disposable_overlay_handles_reorgs_retention_expiry_and_writer_races() -> Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&db, None).await?;
    db.execute_unprepared(
        "CREATE TABLE canonical_marker(value bigint); INSERT INTO canonical_marker VALUES(42)",
    )
    .await?;
    let store = Store { db, domain: 1 };
    store.reset().await?;
    let source = MockSource(Mutex::new((10, 100, true)));
    let lease = Duration::from_secs(30);
    assert!(tick(&source, &store, 4, 2, lease).await?);
    assert_eq!(
        scalar(&store, "SELECT count(*) AS n FROM scraper_tip_visible").await?,
        0
    );
    assert!(!tick(&source, &store, 4, 2, lease).await?);
    assert_eq!(
        scalar(&store, "SELECT count(*) AS n FROM scraper_tip_visible").await?,
        4
    );
    assert!(!tick(&source, &store, 4, 2, lease).await?);
    assert_eq!(
        scalar(&store, "SELECT count(*) AS n FROM scraper_tip_event").await?,
        4
    );
    // A shallow fork can delete every event. Rebuilding must remove orphan rows.
    *source.0.lock().expect("mock lock") = (10, 200, false);
    assert!(tick(&FailedLogs(&source), &store, 4, 2, lease)
        .await
        .is_err());
    assert_eq!(
        scalar(&store, "SELECT count(*) AS n FROM scraper_tip_visible").await?,
        0
    );
    assert!(tick(&source, &store, 4, 2, lease).await?);
    assert!(!tick(&source, &store, 4, 2, lease).await?);
    assert_eq!(
        scalar(&store, "SELECT count(*) AS n FROM scraper_tip_event").await?,
        0
    );
    // Canonical stall does not prevent pruning, nor require historical catch-up.
    *source.0.lock().expect("mock lock") = (1000, 200, true);
    assert!(!tick(&source, &store, 4, 10, lease).await?);
    assert_eq!(
        scalar(
            &store,
            "SELECT min(block_number) AS n FROM scraper_tip_event"
        )
        .await?,
        997
    );
    assert_eq!(
        scalar(&store, "SELECT count(*) AS n FROM scraper_tip_event").await?,
        4
    );
    assert_eq!(
        scalar(&store, "SELECT value AS n FROM canonical_marker").await?,
        42
    );
    store
        .db
        .execute_unprepared("UPDATE scraper_tip_head SET valid_until=now()-interval '1 second'")
        .await?;
    assert_eq!(
        scalar(&store, "SELECT count(*) AS n FROM scraper_tip_visible").await?,
        0
    );
    let stale = store.state().await?;
    assert!(!tick(&source, &store, 4, 10, lease).await?);
    let header = source.header(BlockNumber::Latest).await?;
    assert!(store
        .commit(&stale, &header, 997, &[], true, true, lease)
        .await
        .is_err());
    assert_eq!(
        scalar(&store, "SELECT count(*) AS n FROM scraper_tip_event").await?,
        4
    );
    let pending = store.state().await?;
    store.pause_revision(pending.revision).await?;
    assert!(store
        .commit(&pending, &header, 997, &[], false, true, lease)
        .await
        .is_err());
    assert_eq!(
        scalar(&store, "SELECT count(*) AS n FROM scraper_tip_visible").await?,
        0
    );
    store.reset().await?;
    assert_eq!(
        scalar(&store, "SELECT count(*) AS n FROM scraper_tip_event").await?,
        0
    );
    migration::Migrator::down(&store.db, Some(1)).await?;
    assert_eq!(
        scalar(&store, "SELECT value AS n FROM canonical_marker").await?,
        42
    );
    Ok(())
}

#[test]
fn config_accepts_environment_numbers() -> Result<()> {
    let config: Config = serde_json::from_str(r#"{"windowBlocks":"256"}"#)?;
    assert_eq!(config.window_blocks, 256);
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn slow_fetch_cannot_renew_an_expired_observation() {
    let observed = Instant::now();
    tokio::time::advance(Duration::from_secs(2)).await;
    assert!(remaining_lease(Duration::from_secs(1), observed).is_err());
}
