//! Build scope/id indexes for event write accounting outside migration transactions.

use eyre::{ensure, Context};
use migration::sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};

mod common;

const INDEXES: [(&str, &str, &str, &str); 2] = [
    (
        "message_origin_mailbox_id_idx",
        "message",
        "origin",
        "origin_mailbox",
    ),
    (
        "delivered_message_domain_mailbox_id_idx",
        "delivered_message",
        "domain",
        "destination_mailbox",
    ),
];

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
        db.execute_unprepared("DROP INDEX message_origin_mailbox_id_idx")
            .await?;
        db.execute_unprepared(
            "CREATE INDEX message_origin_mailbox_id_idx ON message (origin, origin_mailbox, nonce)",
        )
        .await?;
        assert!(create_indexes(&db)
            .await
            .unwrap_err()
            .to_string()
            .contains("unexpected definition"));
        db.execute_unprepared("DROP INDEX message_origin_mailbox_id_idx")
            .await?;
        db.execute_unprepared(
            "INSERT INTO message (time_created,msg_id,origin,destination,nonce,sender,recipient,origin_mailbox) SELECT now(),decode(repeat('01',32),'hex'),1,1,n,decode(repeat('01',20),'hex'),decode(repeat('01',20),'hex'),decode(repeat('01',20),'hex') FROM generate_series(0,1) n"
        ).await?;
        // A failed concurrent unique build leaves a real invalid index behind.
        assert!(db.execute_unprepared(
            "CREATE UNIQUE INDEX CONCURRENTLY message_origin_mailbox_id_idx ON message(origin,origin_mailbox)"
        ).await.is_err());
        let validity = db.query_one(Statement::from_string(DbBackend::Postgres,
            "SELECT indisvalid FROM pg_index WHERE indexrelid='message_origin_mailbox_id_idx'::regclass"
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
