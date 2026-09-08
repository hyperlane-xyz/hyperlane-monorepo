use std::collections::BTreeMap;

use migration::MigratorTrait;
use sea_orm::{Database, DatabaseBackend, DbErr, MockDatabase, Value};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use super::*;

// The CCR caller forces persistence only if update did not already succeed.
async fn update_and_persist(cursor: &BlockCursor, height: u64) -> Result<()> {
    if !cursor.update(height).await {
        cursor.flush().await?;
    }
    Ok(())
}

#[tokio::test]
async fn cursor_updates_report_success_without_losing_retry_or_throttle_behavior() {
    // expired, requested height, failed writes, expected attempts
    for (expired, height, failures, attempts) in [
        (true, 100, 0, 1),
        (false, 100, 0, 1),
        (true, 50, 0, 1),
        (true, 40, 0, 1),
        (true, 100, 1, 2),
        (true, 100, 2, 2),
    ] {
        let mock = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_errors((0..failures).map(|_| DbErr::Custom("write failed".to_owned())))
            .append_query_results([vec![BTreeMap::from([(
                "id".to_owned(),
                Value::BigInt(Some(1)),
            )])]]);
        let last_saved_at = Instant::now()
            - if expired {
                Duration::from_secs(11)
            } else {
                Duration::ZERO
            };
        let cursor = BlockCursor {
            db: mock.into_connection(),
            domain: 1,
            event_type: "ccr_swap".to_owned(),
            inner: RwLock::new(BlockCursorInner {
                height: 50,
                last_saved_at,
            }),
        };
        let result = update_and_persist(&cursor, height).await;
        assert_eq!(result.is_err(), failures == 2);
        assert_eq!(cursor.height().await, height.max(50));
        let saved = cursor.inner.read().await.last_saved_at;
        if failures == 2 {
            assert_eq!(saved, last_saved_at);
        } else {
            assert!(saved > last_saved_at);
        }
        let log = cursor.db.into_transaction_log();
        assert_eq!(log.len(), attempts);
        for entry in log {
            let query = &entry.statements()[0];
            assert!(query.sql.starts_with("INSERT INTO \"cursor\""));
            assert!(query.sql.contains("GREATEST"));
            let values = &query.values.as_ref().unwrap().0;
            assert!(values.contains(&Value::BigInt(Some(height.max(50) as i64))));
            assert!(values.contains(&Value::String(Some(Box::new("ccr_swap".to_owned())))));
        }
    }
}

#[tokio::test]
async fn cursor_throttled_update_alone_does_not_write() {
    let cursor = BlockCursor {
        db: MockDatabase::new(DatabaseBackend::Postgres).into_connection(),
        domain: 1,
        event_type: String::new(),
        inner: RwLock::new(BlockCursorInner {
            height: 50,
            last_saved_at: Instant::now(),
        }),
    };
    assert!(!cursor.update(100).await);
    assert_eq!(cursor.height().await, 100);
    assert!(cursor.db.into_transaction_log().is_empty());
}

#[tokio::test]
async fn cursor_persistence_is_monotonic_scoped_and_survives_reopen_in_postgres() -> Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let url = format!("postgresql://postgres:postgres@127.0.0.1:{port}/postgres");
    let connection = Database::connect(&url).await?;
    migration::Migrator::up(&connection, None).await?;
    let connection = ScraperDb::with_connection(connection);
    let first = BlockCursor::new(connection.clone_connection(), 1, "ccr_swap", 50).await?;
    let second = BlockCursor::new(Database::connect(&url).await?, 1, "ccr_swap", 50).await?;
    let messages = BlockCursor::new(connection.clone_connection(), 1, "", 10).await?;
    let other_domain = BlockCursor::new(connection.clone_connection(), 137, "ccr_swap", 20).await?;
    update_and_persist(&messages, 11).await?;
    update_and_persist(&other_domain, 21).await?;
    first.inner.write().await.last_saved_at = Instant::now() - Duration::from_secs(11);
    let (a, b) = tokio::join!(
        update_and_persist(&first, 100),
        update_and_persist(&second, 80)
    );
    a?;
    b?;
    update_and_persist(&second, 60).await?; // Stale writer must not lower SQL height.
    drop(first);
    drop(second);
    drop(messages);
    drop(other_domain);
    drop(connection);
    let reopened = ScraperDb::with_connection(Database::connect(&url).await?);
    assert_eq!(
        BlockCursor::new(reopened.clone_connection(), 1, "ccr_swap", 0)
            .await?
            .height()
            .await,
        100
    );
    assert_eq!(
        BlockCursor::new(reopened.clone_connection(), 1, "", 0)
            .await?
            .height()
            .await,
        11
    );
    assert_eq!(
        BlockCursor::new(reopened.clone_connection(), 137, "ccr_swap", 0)
            .await?
            .height()
            .await,
        21
    );
    Ok(())
}

#[tokio::test]
async fn backward_cursors_are_durable_and_event_specific() -> Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let url = format!("postgresql://postgres:postgres@127.0.0.1:{port}/postgres");
    let connection = Database::connect(&url).await?;
    migration::Migrator::up(&connection, None).await?;

    let db = ScraperDb::connect(&url).await?;
    let message = BackwardCursorProgress {
        sequence: u32::MAX,
        block: 34,
    };
    let payment = BackwardCursorProgress {
        sequence: 56,
        block: u32::MAX,
    };
    db.store_backward_cursor(13375, "message", message).await?;
    db.store_backward_cursor(13375, "gas_payment", payment)
        .await?;
    let updated_message = BackwardCursorProgress {
        sequence: 12,
        block: 34,
    };
    db.store_backward_cursor(13375, "message", updated_message)
        .await?;
    db.store_backward_cursor(13375, "message", message).await?;
    let rewind = BackwardCursorProgress {
        sequence: 12,
        block: 500,
    };
    db.reset_backward_cursor(13375, "message", rewind).await?;

    let reopened = ScraperDb::connect(&url).await?;
    let message_cursors = reopened.retrieve_backward_cursors(13375, "message").await?;
    assert!(message_cursors.contains(&rewind));
    assert!(message_cursors.contains(&message));
    assert_eq!(
        reopened
            .retrieve_backward_cursors(13375, "gas_payment")
            .await?,
        vec![payment]
    );
    assert_eq!(
        reopened
            .retrieve_backward_cursors(13375, "delivery")
            .await?,
        Vec::new()
    );
    reopened
        .delete_backward_cursor(13375, "message", message.sequence)
        .await?;
    assert_eq!(
        reopened.retrieve_backward_cursors(13375, "message").await?,
        vec![rewind]
    );
    Ok(())
}
