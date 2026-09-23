use eyre::{ensure, Context};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};

pub struct ScraperIndex {
    name: &'static str,
    table: &'static str,
    keys: &'static [&'static str],
    predicate: Option<&'static str>,
}

pub const RAW_DISPATCH_RECONCILIATION: ScraperIndex = ScraperIndex {
    name: "raw_message_dispatch_reconciliation_idx",
    table: "raw_message_dispatch",
    keys: &["origin_domain", "origin_mailbox", "id"],
    predicate: Some("(msg_body IS NOT NULL)"),
};
pub const RAW_DISPATCH_NATIVE_SEQUENCE: ScraperIndex = ScraperIndex {
    name: "raw_message_dispatch_native_sequence_idx",
    table: "raw_message_dispatch",
    keys: &["origin_domain", "origin_mailbox", "nonce"],
    predicate: None,
};
pub const DELIVERY_SCOPE: ScraperIndex = ScraperIndex {
    name: "delivered_message_domain_mailbox_id_idx",
    table: "delivered_message",
    keys: &["domain", "destination_mailbox", "id"],
    predicate: None,
};

pub const MERKLE_BLOCK_HEIGHT: ScraperIndex = ScraperIndex {
    name: "merkle_insertion_block_height",
    table: "merkle_tree_insertion",
    keys: &["domain", "block_number"],
    predicate: None,
};

/// Run after transactional migrations have committed. Concurrent index creation
/// cannot run inside the SeaORM migration transaction.
pub async fn create_indexes(db: &DatabaseConnection) -> eyre::Result<()> {
    for index in [
        RAW_DISPATCH_RECONCILIATION,
        RAW_DISPATCH_NATIVE_SEQUENCE,
        DELIVERY_SCOPE,
        MERKLE_BLOCK_HEIGHT,
    ] {
        create_index(db, index).await?;
    }
    Ok(())
}

pub async fn create_index(db: &DatabaseConnection, index: ScraperIndex) -> eyre::Result<()> {
    let ScraperIndex {
        name,
        table,
        keys,
        predicate,
    } = index;
    let columns = keys.join(", ");
    let filter = predicate.map(|p| format!(" WHERE {p}")).unwrap_or_default();
    db.execute_unprepared(&format!(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} ON {table} ({columns}){filter}"
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
                AND i.indnkeyatts = $5 AND i.indnatts = $5
                AND pg_get_expr(i.indpred, i.indrelid) IS NOT DISTINCT FROM $4::text
                AND i.indexprs IS NULL
                AND i.indrelid = $2::regclass AND am.amname = 'btree'
                AND (SELECT string_agg(pg_get_indexdef(i.indexrelid, n, true), ',' ORDER BY n)
                     FROM generate_series(1, i.indnkeyatts) n) = $3
                AS expected_index
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_am am ON am.oid = c.relam
            WHERE i.indexrelid = to_regclass($1)
            "#,
            vec![
                name.into(),
                table.into(),
                keys.join(",").into(),
                predicate.map(str::to_owned).into(),
                i16::try_from(keys.len())?.into(),
            ],
        ))
        .await?;
    let valid = row
        .map(|row| row.try_get::<bool>("", "expected_index"))
        .transpose()?
        .unwrap_or(false);
    ensure!(valid, "Index {name} is invalid or has an unexpected definition; inspect pg_index and pg_get_indexdef, repair it explicitly, then rerun this command");
    tracing::info!(index = name, "Verified scraper index");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Migrator, MigratorTrait};
    use sea_orm::Database;
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
