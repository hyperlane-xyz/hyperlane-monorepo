use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// Assigns a commit-ordered cursor to each resolved gas payment.
///
/// PostgreSQL sequence values are allocated before commit, so the
/// `gas_payment.id` order can differ from commit/notification order. The head
/// row is locked until the inserting transaction commits. A second insert for
/// the same domain/paymaster therefore cannot allocate its cursor or commit
/// ahead of the first allocator. Existing row IDs remain valid cursors; each
/// head starts at that stream's highest resolved legacy ID, avoiding an
/// outbox-row rewrite for historical payments.
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                LOCK TABLE gas_payment IN SHARE ROW EXCLUSIVE MODE;

                CREATE TABLE gas_payment_stream_head (
                  domain bigint NOT NULL,
                  interchain_gas_paymaster bytea NOT NULL,
                  last_cursor bigint NOT NULL CHECK (last_cursor >= 0),
                  PRIMARY KEY (domain, interchain_gas_paymaster)
                );

                CREATE TABLE gas_payment_stream_cursor (
                  gas_payment_id bigint PRIMARY KEY
                    REFERENCES gas_payment(id) ON DELETE CASCADE,
                  domain bigint NOT NULL,
                  interchain_gas_paymaster bytea NOT NULL,
                  stream_cursor bigint NOT NULL CHECK (stream_cursor > 0),
                  UNIQUE (domain, interchain_gas_paymaster, stream_cursor)
                );

                INSERT INTO gas_payment_stream_head (
                  domain,
                  interchain_gas_paymaster,
                  last_cursor
                )
                SELECT
                  domain,
                  interchain_gas_paymaster,
                  MAX(id)
                FROM gas_payment
                WHERE tx_id IS NOT NULL
                GROUP BY domain, interchain_gas_paymaster;

                CREATE OR REPLACE FUNCTION assign_gas_payment_stream_cursor()
                RETURNS trigger
                LANGUAGE plpgsql
                AS $$
                DECLARE
                  assigned_cursor bigint;
                BEGIN
                  IF NEW.tx_id IS NULL THEN
                    RETURN NEW;
                  END IF;

                  INSERT INTO gas_payment_stream_head (
                    domain,
                    interchain_gas_paymaster,
                    last_cursor
                  ) VALUES (
                    NEW.domain,
                    NEW.interchain_gas_paymaster,
                    0
                  )
                  ON CONFLICT (domain, interchain_gas_paymaster) DO NOTHING;

                  UPDATE gas_payment_stream_head
                  SET last_cursor = last_cursor + 1
                  WHERE domain = NEW.domain
                    AND interchain_gas_paymaster = NEW.interchain_gas_paymaster
                  RETURNING last_cursor INTO STRICT assigned_cursor;

                  INSERT INTO gas_payment_stream_cursor (
                    gas_payment_id,
                    domain,
                    interchain_gas_paymaster,
                    stream_cursor
                  ) VALUES (
                    NEW.id,
                    NEW.domain,
                    NEW.interchain_gas_paymaster,
                    assigned_cursor
                  );

                  RETURN NEW;
                END;
                $$;

                DROP TRIGGER IF EXISTS gas_payment_stream_cursor_assign ON gas_payment;
                CREATE TRIGGER gas_payment_stream_cursor_assign
                  AFTER INSERT ON gas_payment
                  FOR EACH ROW
                  EXECUTE FUNCTION assign_gas_payment_stream_cursor();
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                DROP TRIGGER IF EXISTS gas_payment_stream_cursor_assign ON gas_payment;
                DROP FUNCTION IF EXISTS assign_gas_payment_stream_cursor();
                DROP TABLE IF EXISTS gas_payment_stream_cursor;
                DROP TABLE IF EXISTS gas_payment_stream_head;
                "#,
            )
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use sea_orm::{
        ConnectOptions, ConnectionTrait, Database, DbBackend, Statement, TransactionTrait,
    };
    use testcontainers::runners::AsyncRunner;
    use testcontainers_modules::postgres::Postgres;
    use tokio::time::{sleep, timeout};

    use super::*;

    const PAYMASTER: &str = "1111111111111111111111111111111111111111";
    const TEST_LOCK: i64 = 8_030_013;

    #[tokio::test]
    async fn cursor_follows_commit_order_not_row_id_allocation() -> Result<(), DbErr> {
        let postgres = Postgres::default().start().await.expect("start postgres");
        let port = postgres
            .get_host_port_ipv4(5432)
            .await
            .expect("postgres port");
        let url = format!("postgresql://postgres:postgres@127.0.0.1:{port}/postgres");
        let db = Database::connect(&url).await?;
        db.execute_unprepared(
            r#"
            CREATE TABLE gas_payment (
              id bigserial PRIMARY KEY,
              domain bigint NOT NULL,
              interchain_gas_paymaster bytea NOT NULL,
              tx_id bigint,
              hold_before_insert boolean NOT NULL DEFAULT false
            );
            "#,
        )
        .await?;
        db.execute_unprepared(&format!(
            "INSERT INTO gas_payment (domain, interchain_gas_paymaster, tx_id) VALUES (1, decode('{PAYMASTER}', 'hex'), 10), (1, decode('{PAYMASTER}', 'hex'), 11)"
        ))
        .await?;
        let migration_tx = db.begin().await?;
        Migration.up(&SchemaManager::new(&migration_tx)).await?;
        migration_tx.commit().await?;

        let legacy_mapping_count = db
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "SELECT COUNT(*) AS count FROM gas_payment_stream_cursor".to_owned(),
            ))
            .await?
            .expect("legacy mapping count")
            .try_get::<i64>("", "count")?;
        assert_eq!(legacy_mapping_count, 0);

        db.execute_unprepared(&format!(
            r#"
            CREATE OR REPLACE FUNCTION hold_first_gas_payment()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.hold_before_insert THEN
                PERFORM pg_advisory_xact_lock({TEST_LOCK});
              END IF;
              RETURN NEW;
            END;
            $$;
            CREATE TRIGGER a_hold_first_gas_payment
              BEFORE INSERT ON gas_payment
              FOR EACH ROW EXECUTE FUNCTION hold_first_gas_payment();
            "#
        ))
        .await?;

        let mut gate_options = ConnectOptions::new(url.clone());
        gate_options.max_connections(1).min_connections(1);
        let gate = Database::connect(gate_options).await?;
        gate.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT pg_advisory_lock($1)",
            [TEST_LOCK.into()],
        ))
        .await?;

        let first_db = Database::connect(&url).await?;
        let first = tokio::spawn(async move {
            first_db
                .execute_unprepared(&format!(
                    "INSERT INTO gas_payment (domain, interchain_gas_paymaster, tx_id, hold_before_insert) VALUES (1, decode('{PAYMASTER}', 'hex'), 1, true)"
                ))
                .await
        });

        timeout(Duration::from_secs(10), async {
            loop {
                let value = db
                    .query_one(Statement::from_string(
                        DbBackend::Postgres,
                        "SELECT last_value FROM gas_payment_id_seq".to_owned(),
                    ))
                    .await?
                    .expect("sequence row")
                    .try_get::<i64>("", "last_value")?;
                if value >= 3 {
                    return Ok::<_, DbErr>(());
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("first insert allocated its row ID")?;

        db.execute_unprepared(&format!(
            "INSERT INTO gas_payment (domain, interchain_gas_paymaster, tx_id) VALUES (1, decode('{PAYMASTER}', 'hex'), 2)"
        ))
        .await?;

        gate.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT pg_advisory_unlock($1)",
            [TEST_LOCK.into()],
        ))
        .await?;
        timeout(Duration::from_secs(10), first)
            .await
            .expect("first insert completed")
            .expect("first task joined")?;

        let rollback_tx = db.begin().await?;
        rollback_tx
            .execute_unprepared(&format!(
                "INSERT INTO gas_payment (domain, interchain_gas_paymaster, tx_id) VALUES (1, decode('{PAYMASTER}', 'hex'), 3)"
            ))
            .await?;
        rollback_tx.rollback().await?;
        db.execute_unprepared(&format!(
            "INSERT INTO gas_payment (domain, interchain_gas_paymaster, tx_id) VALUES (1, decode('{PAYMASTER}', 'hex'), 4)"
        ))
        .await?;

        let held = db.begin().await?;
        held.execute_unprepared(&format!(
            "INSERT INTO gas_payment (domain, interchain_gas_paymaster, tx_id) VALUES (1, decode('{PAYMASTER}', 'hex'), 5)"
        ))
        .await?;
        timeout(
            Duration::from_secs(2),
            db.execute_unprepared(
                "INSERT INTO gas_payment (domain, interchain_gas_paymaster, tx_id) VALUES (1, decode('2222222222222222222222222222222222222222', 'hex'), 6)",
            ),
        )
        .await
        .expect("an unrelated paymaster must not wait on the held stream head")?;
        held.rollback().await?;

        let rows = db
            .query_all(Statement::from_string(
                DbBackend::Postgres,
                format!(
                    "SELECT gas_payment_id, stream_cursor FROM gas_payment_stream_cursor WHERE interchain_gas_paymaster = decode('{PAYMASTER}', 'hex') ORDER BY stream_cursor"
                ),
            ))
            .await?;
        let observed = rows
            .iter()
            .map(|row| {
                Ok((
                    row.try_get::<i64>("", "gas_payment_id")?,
                    row.try_get::<i64>("", "stream_cursor")?,
                ))
            })
            .collect::<Result<Vec<_>, DbErr>>()?;
        assert_eq!(observed, vec![(4, 3), (3, 4), (6, 5)]);

        let unrelated = db
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "SELECT stream_cursor FROM gas_payment_stream_cursor WHERE interchain_gas_paymaster = decode('2222222222222222222222222222222222222222', 'hex')"
                    .to_owned(),
            ))
            .await?
            .expect("unrelated stream cursor")
            .try_get::<i64>("", "stream_cursor")?;
        assert_eq!(unrelated, 1);
        Ok(())
    }
}
