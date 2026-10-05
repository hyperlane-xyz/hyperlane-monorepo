use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE scraper_head ADD COLUMN verified_height bigint; ALTER TABLE scraper_head ADD CONSTRAINT scraper_head_verified_height_check CHECK(verified_height IS NULL OR (verified_height>=confirmed_height AND verified_height<=indexed_height))",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                SET LOCAL lock_timeout = '5s';
                DO $$ BEGIN
                  IF EXISTS (
                    SELECT 1 FROM gas_payment WHERE block_hash IS NOT NULL
                    GROUP BY domain,block_hash,transaction_index,log_index HAVING count(*)>1
                  ) THEN
                    RAISE EXCEPTION 'Cannot downgrade: gas payments collide under the previous transaction-scoped identity';
                  END IF;
                END $$;
                CREATE UNIQUE INDEX IF NOT EXISTS gas_payment_transaction_log
                  ON gas_payment(domain,block_hash,transaction_index,log_index)
                  WHERE block_hash IS NOT NULL;
                DROP INDEX IF EXISTS gas_payment_block_log;
                ALTER TABLE scraper_head DROP CONSTRAINT scraper_head_verified_height_check,
                  DROP COLUMN verified_height;
                "#,
            )
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use testcontainers::{runners::AsyncRunner, ContainerAsync};
    use testcontainers_modules::postgres::Postgres;

    use super::*;
    use crate::{Migrator, MigratorTrait};

    async fn database() -> Result<(sea_orm::DatabaseConnection, ContainerAsync<Postgres>), DbErr> {
        let postgres = Postgres::default().start().await.expect("start postgres");
        let url = format!(
            "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
            postgres
                .get_host_port_ipv4(5432)
                .await
                .expect("postgres port")
        );
        let db = Database::connect(url).await?;
        Migrator::up(&db, None).await?;
        crate::indexes::create_indexes(&db)
            .await
            .map_err(|error| DbErr::Custom(error.to_string()))?;
        Ok((db, postgres))
    }

    async fn index_exists(db: &sea_orm::DatabaseConnection, name: &str) -> Result<bool, DbErr> {
        let row = db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT to_regclass($1) IS NOT NULL AS present",
                [name.into()],
            ))
            .await?
            .expect("index presence row");
        row.try_get("", "present")
    }

    #[tokio::test]
    async fn downgrade_restores_the_index_expected_by_the_previous_binary() -> Result<(), DbErr> {
        let (db, _postgres) = database().await?;

        Migrator::down(&db, Some(1)).await?;

        assert!(index_exists(&db, "gas_payment_transaction_log").await?);
        assert!(!index_exists(&db, "gas_payment_block_log").await?);
        Ok(())
    }

    #[tokio::test]
    async fn downgrade_refuses_rows_that_the_previous_index_cannot_represent() -> Result<(), DbErr>
    {
        let (db, _postgres) = database().await?;
        db.execute_unprepared(
            r#"
            INSERT INTO gas_payment
              (domain,block_hash,block_number,transaction_hash,transaction_index,log_index,
               interchain_gas_paymaster,msg_id,destination,gas_amount,payment,origin)
            VALUES
              (1,decode(repeat('aa',32),'hex'),10,decode(repeat('01',32),'hex'),0,0,
               decode(repeat('11',20),'hex'),decode(repeat('01',32),'hex'),2,1,1,1),
              (1,decode(repeat('aa',32),'hex'),10,decode(repeat('02',32),'hex'),0,0,
               decode(repeat('11',20),'hex'),decode(repeat('02',32),'hex'),2,1,1,1)
            "#,
        )
        .await?;

        let error = Migrator::down(&db, Some(1))
            .await
            .expect_err("colliding rows cannot be downgraded safely");
        assert!(error.to_string().contains("Cannot downgrade"));
        assert!(index_exists(&db, "gas_payment_block_log").await?);
        assert!(!index_exists(&db, "gas_payment_transaction_log").await?);
        Ok(())
    }
}
