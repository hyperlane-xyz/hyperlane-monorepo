use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// Chains that number logs per transaction (e.g. ENI) reuse log indexes inside a
/// block, so stream cursors must follow the transaction index first.
const CHAIN_ORDER: &str = "g.block_number,g.transaction_index,g.log_index,g.id";
const LEGACY_ORDER: &str = "g.block_number,g.log_index,g.id";

/// `CREATE OR REPLACE` keeps the function's owner and grants.
fn assign_cursors_function(order: &str) -> String {
    format!(
        r#"
CREATE OR REPLACE FUNCTION assign_confirmed_gas_payment_cursors(
  target_domain integer, after_height bigint, through_height bigint
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE item record; assigned bigint := 0; first_cursor bigint;
BEGIN
  FOR item IN
    SELECT interchain_gas_paymaster,count(*)::bigint AS count FROM gas_payment g
    WHERE g.domain=target_domain AND g.block_number>after_height AND g.block_number<=through_height
      AND NOT EXISTS (SELECT 1 FROM gas_payment_stream_cursor c WHERE c.gas_payment_id=g.id)
    GROUP BY interchain_gas_paymaster ORDER BY interchain_gas_paymaster
  LOOP
    INSERT INTO gas_payment_stream_head(domain,interchain_gas_paymaster,legacy_max_id,last_cursor)
      VALUES(target_domain,item.interchain_gas_paymaster,0,0) ON CONFLICT DO NOTHING;
    UPDATE gas_payment_stream_head SET last_cursor=last_cursor+item.count
      WHERE domain=target_domain AND interchain_gas_paymaster=item.interchain_gas_paymaster
      RETURNING last_cursor-item.count+1 INTO STRICT first_cursor;
    INSERT INTO gas_payment_stream_cursor(gas_payment_id,domain,interchain_gas_paymaster,stream_cursor)
      SELECT g.id,g.domain,g.interchain_gas_paymaster,
        first_cursor+row_number() OVER (ORDER BY {order})-1
      FROM gas_payment g
      WHERE g.domain=target_domain AND g.interchain_gas_paymaster=item.interchain_gas_paymaster
        AND g.block_number>after_height AND g.block_number<=through_height
        AND NOT EXISTS (SELECT 1 FROM gas_payment_stream_cursor c WHERE c.gas_payment_id=g.id)
      ORDER BY {order};
    assigned := assigned+item.count;
  END LOOP;
  RETURN assigned;
END $$;
"#
    )
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(&assign_cursors_function(CHAIN_ORDER))
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(&assign_cursors_function(LEGACY_ORDER))
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

    fn payment(transaction_index: u32, log_index: u32, byte: &str) -> String {
        format!(
            "INSERT INTO gas_payment (domain,block_hash,block_number,transaction_hash,transaction_index,log_index,interchain_gas_paymaster,msg_id,destination,gas_amount,payment,origin) VALUES (1,decode(repeat('aa',32),'hex'),10,decode(repeat('{byte}',32),'hex'),{transaction_index},{log_index},decode(repeat('11',20),'hex'),decode(repeat('{byte}',32),'hex'),2,1,1,1)"
        )
    }

    async fn cursors_in_tx_order(db: &impl ConnectionTrait) -> Result<Vec<i64>, DbErr> {
        db.query_all(Statement::from_string(
            DbBackend::Postgres,
            "SELECT g.transaction_index FROM gas_payment_stream_cursor c JOIN gas_payment g ON g.id=c.gas_payment_id ORDER BY c.stream_cursor".to_owned(),
        ))
        .await?
        .iter()
        .map(|row| row.try_get::<i64>("", "transaction_index"))
        .collect()
    }

    #[tokio::test]
    async fn assigns_cursors_in_chain_order_with_per_transaction_log_indexes() -> Result<(), DbErr>
    {
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
            .map_err(|err| DbErr::Custom(err.to_string()))?;
        // Near-head rows defer cursor assignment to confirmation while the domain
        // has a scraper_head row.
        db.execute_unprepared(
            "INSERT INTO block(domain,hash,height,timestamp) VALUES (1,decode(repeat('aa',32),'hex'),10,now());
             INSERT INTO scraper_head(domain,start_height,indexed_height,indexed_hash,head_height,confirmed_height,mailbox,merkle_tree_hook,interchain_gas_paymaster)
               VALUES (1,10,10,decode(repeat('aa',32),'hex'),10,10,decode(repeat('01',20),'hex'),decode(repeat('02',20),'hex'),decode(repeat('11',20),'hex'))",
        )
        .await?;
        // Inserted out of chain order: tx 1 / log 0 sorts before tx 0 / log 1 by
        // log index alone.
        db.execute_unprepared(&payment(1, 0, "02")).await?;
        db.execute_unprepared(&payment(0, 1, "01")).await?;

        db.execute_unprepared("SELECT assign_confirmed_gas_payment_cursors(1,0,10)")
            .await?;
        assert_eq!(cursors_in_tx_order(&db).await?, vec![0, 1]);

        // Rolling back restores the legacy log-index order.
        db.execute_unprepared(
            "DELETE FROM gas_payment_stream_cursor; DELETE FROM gas_payment_stream_head",
        )
        .await?;
        Migrator::down(&db, Some(2)).await?;
        db.execute_unprepared("SELECT assign_confirmed_gas_payment_cursors(1,0,10)")
            .await?;
        assert_eq!(cursors_in_tx_order(&db).await?, vec![1, 0]);
        Ok(())
    }
}
