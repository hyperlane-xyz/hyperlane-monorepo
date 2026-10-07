use std::process::Command;

use migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

#[tokio::test]
async fn init_db_migrates_builds_indexes_and_can_be_retried() -> eyre::Result<()> {
    let postgres = Postgres::default().start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_init-db"))
            .env("DATABASE_URL", &url)
            .output()
    };
    let db = Database::connect(&url).await?;
    for _ in 0..2 {
        let output = run()?;
        assert!(output.status.success(), "init-db failed: {output:?}");
        let row = db.query_one(Statement::from_string(DbBackend::Postgres, r#"
            SELECT count(*) AS n FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
            WHERE c.relname IN ('raw_message_dispatch_reconciliation_idx',
                'raw_message_dispatch_native_sequence_idx', 'delivered_message_domain_mailbox_id_idx',
                'merkle_insertion_block_height')
                AND i.indisvalid AND i.indisready
        "#)).await?.unwrap();
        assert_eq!(row.try_get::<i64>("", "n")?, 4);
        let row = db.query_one(Statement::from_string(DbBackend::Postgres,
            "SELECT indnkeyatts AS n FROM pg_index WHERE indexrelid='gas_payment_block_log'::regclass".to_owned())).await?.unwrap();
        assert_eq!(row.try_get::<i16>("", "n")?, 10);
    }
    for (name, definition) in [
        (
            "raw_message_dispatch_reconciliation_idx",
            "raw_message_dispatch(origin_domain,origin_mailbox,id)",
        ),
        (
            "raw_message_dispatch_native_sequence_idx",
            "raw_message_dispatch(origin_domain,origin_mailbox,id)",
        ),
    ] {
        db.execute_unprepared(&format!(
            "DROP INDEX {name}; CREATE INDEX {name} ON {definition}"
        ))
        .await?;
        let output = run()?;
        assert!(
            !output.status.success(),
            "Must reject conflicting index {name}"
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("unexpected definition"), "{stderr}");
        // A failed index phase leaves completed migrations recorded.
        let row = db.query_one(Statement::from_string(DbBackend::Postgres,
            "SELECT count(*) AS n FROM seaql_migrations WHERE version='m20260922_000014_near_head'"
        )).await?.unwrap();
        assert_eq!(row.try_get::<i64>("", "n")?, 1);
        db.execute_unprepared(&format!("DROP INDEX {name}")).await?;
        let output = run()?;
        assert!(output.status.success(), "Retry failed: {output:?}");
    }
    Ok(())
}
