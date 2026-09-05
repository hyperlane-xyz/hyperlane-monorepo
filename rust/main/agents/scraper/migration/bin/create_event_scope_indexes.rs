//! Build scope/id indexes for event write accounting outside migration transactions.

use eyre::{ensure, Context};
use migration::sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};

mod common;

// The message-table candidate `message(origin, origin_mailbox, id)` is deferred:
// the dispatch store counts affected rows instead of issuing the scoped
// MAX(id)/COUNT queries it was built for, so no current scraper query justifies
// maintaining it. Only the delivery index, serving the `store_deliveries`
// scoped MAX(id) lookup, is installed here.
const INDEXES: [(&str, &str, &str, &str); 1] = [(
    "delivered_message_domain_mailbox_id_idx",
    "delivered_message",
    "domain",
    "destination_mailbox",
)];

async fn create_indexes(db: &DatabaseConnection) -> eyre::Result<()> {
    for (name, table, domain, mailbox) in INDEXES {
        db.execute_unprepared(&format!(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} ON {table} ({domain}, {mailbox}, id)"
        ))
        .await
        .wrap_err_with(|| {
            format!("Creating {name}; inspect its validity before retrying an interrupted build")
        })?;

        // IF NOT EXISTS also skips invalid or differently defined indexes. Never
        // report those as successfully installed, and never drop them automatically.
        let row = db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"
            SELECT i.indisvalid AND i.indisready
                AND NOT i.indisunique
                AND i.indnkeyatts = 3 AND i.indnatts = 3
                AND i.indpred IS NULL AND i.indexprs IS NULL
                AND i.indrelid = $2::regclass AND am.amname = 'btree'
                AND pg_get_indexdef(i.indexrelid, 1, true) = $3
                AND pg_get_indexdef(i.indexrelid, 2, true) = $4
                AND pg_get_indexdef(i.indexrelid, 3, true) = 'id'
                AS expected_index
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_am am ON am.oid = c.relam
            WHERE i.indexrelid = to_regclass($1)
            "#,
                [name.into(), table.into(), domain.into(), mailbox.into()],
            ))
            .await?;
        let valid = row
            .map(|row| row.try_get::<bool>("", "expected_index"))
            .transpose()?
            .unwrap_or(false);
        ensure!(valid, "Index {name} is invalid or has an unexpected definition; inspect pg_index and pg_get_indexdef, repair it explicitly, then rerun this command");
        tracing::info!(index = name, "Verified event scope index");
    }
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> eyre::Result<()> {
    create_indexes(&common::init().await?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use migration::sea_orm::Database;
    use migration::{Migrator, MigratorTrait};
    use testcontainers::runners::AsyncRunner;
    use testcontainers_modules::postgres::Postgres;

    #[tokio::test]
    async fn event_scope_indexes_build_rerun_and_reject_wrong_definition() -> eyre::Result<()> {
        let postgres = Postgres::default().start().await?;
        let port = postgres.get_host_port_ipv4(5432).await?;
        let db = Database::connect(format!(
            "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
        ))
        .await?;
        Migrator::up(&db, None).await?;
        create_indexes(&db).await?;
        create_indexes(&db).await?;
        db.execute_unprepared("DROP INDEX delivered_message_domain_mailbox_id_idx")
            .await?;
        db.execute_unprepared(
            "CREATE INDEX delivered_message_domain_mailbox_id_idx ON delivered_message (domain, destination_mailbox)",
        )
        .await?;
        assert!(create_indexes(&db)
            .await
            .unwrap_err()
            .to_string()
            .contains("unexpected definition"));
        db.execute_unprepared("DROP INDEX delivered_message_domain_mailbox_id_idx")
            .await?;
        // Seed the scope/FK chain so two deliveries share one scope.
        db.execute_unprepared(
            "INSERT INTO domain (id, time_updated, name, native_token, is_test_net, is_deprecated) VALUES (1, now(), 'test', 'TEST', false, false)"
        ).await?;
        db.execute_unprepared(
            "INSERT INTO block (domain, hash, height, timestamp) VALUES (1, decode(repeat('02',32),'hex'), 1, now())"
        ).await?;
        db.execute_unprepared(
            "INSERT INTO \"transaction\" (hash, block_id, gas_limit, nonce, sender, gas_used, cumulative_gas_used) VALUES (decode(repeat('03',32),'hex'), 1, 1, 1, decode(repeat('04',20),'hex'), 1, 1)"
        ).await?;
        db.execute_unprepared(
            "INSERT INTO delivered_message (msg_id, domain, destination_mailbox, destination_tx_id) VALUES (decode(repeat('05',32),'hex'), 1, decode(repeat('06',20),'hex'), 1), (decode(repeat('07',32),'hex'), 1, decode(repeat('06',20),'hex'), 1)"
        ).await?;
        // A failed concurrent unique build leaves a real invalid index behind.
        assert!(db.execute_unprepared(
            "CREATE UNIQUE INDEX CONCURRENTLY delivered_message_domain_mailbox_id_idx ON delivered_message(domain,destination_mailbox)"
        ).await.is_err());
        let validity = db.query_one(Statement::from_string(DbBackend::Postgres,
            "SELECT indisvalid FROM pg_index WHERE indexrelid='delivered_message_domain_mailbox_id_idx'::regclass"
        )).await?.unwrap();
        assert!(!validity.try_get::<bool>("", "indisvalid")?);
        assert!(create_indexes(&db)
            .await
            .unwrap_err()
            .to_string()
            .contains("invalid"));
        Ok(())
    }
}
