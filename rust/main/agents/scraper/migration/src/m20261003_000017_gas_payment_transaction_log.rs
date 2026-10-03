use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                SET LOCAL lock_timeout = '5s';
                DROP INDEX gas_payment_block_log;
                CREATE UNIQUE INDEX gas_payment_block_log
                  ON gas_payment(domain, block_hash, transaction_index, log_index)
                  WHERE block_hash IS NOT NULL;
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
                SET LOCAL lock_timeout = '5s';
                DROP INDEX gas_payment_block_log;
                CREATE UNIQUE INDEX gas_payment_block_log
                  ON gas_payment(domain, block_hash, log_index)
                  WHERE block_hash IS NOT NULL;
                "#,
            )
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use testcontainers::runners::AsyncRunner;
    use testcontainers_modules::postgres::Postgres;

    use super::*;
    use crate::{Migrator, MigratorTrait};

    fn payment(transaction_index: u32, byte: &str) -> String {
        format!(
            "INSERT INTO gas_payment (domain,block_hash,block_number,transaction_hash,transaction_index,log_index,interchain_gas_paymaster,msg_id,destination,gas_amount,payment,origin) VALUES (1,decode(repeat('aa',32),'hex'),10,decode(repeat('{byte}',32),'hex'),{transaction_index},0,decode(repeat('11',20),'hex'),decode(repeat('{byte}',32),'hex'),2,1,1,1)"
        )
    }

    #[tokio::test]
    async fn migrates_existing_table_to_transaction_scoped_log_positions() -> Result<(), DbErr> {
        let postgres = Postgres::default().start().await.expect("start postgres");
        let url = format!(
            "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
            postgres
                .get_host_port_ipv4(5432)
                .await
                .expect("postgres port")
        );
        let db = Database::connect(url).await?;
        let preceding_migrations = Migrator::migrations()
            .iter()
            .position(|migration| migration.name() == Migration.name())
            .expect("gas payment position migration is registered");
        Migrator::up(&db, Some(preceding_migrations as u32)).await?;
        db.execute_unprepared(&payment(0, "01")).await?;

        Migrator::up(&db, None).await?;

        db.execute_unprepared(&payment(1, "02")).await?;
        assert!(db.execute_unprepared(&payment(1, "03")).await.is_err());
        let index = db
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "SELECT pg_get_indexdef('gas_payment_block_log'::regclass) AS definition"
                    .to_owned(),
            ))
            .await?
            .expect("gas payment position index");
        assert!(index
            .try_get::<String>("", "definition")?
            .contains("transaction_index"));
        Ok(())
    }
}
