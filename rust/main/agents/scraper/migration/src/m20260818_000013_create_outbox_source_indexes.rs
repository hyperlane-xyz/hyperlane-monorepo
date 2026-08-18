use sea_orm_migration::prelude::*;

use crate::m20230309_000004_create_table_gas_payment::GasPayment;
use crate::m20230309_000005_create_table_message::Message;
use crate::m20260817_000012_create_table_merkle_tree_insertion::MerkleTreeInsertion;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// The indexes on populated source tables are created by the
/// `create-outbox-source-indexes` bin because Postgres requires
/// `CREATE INDEX CONCURRENTLY` to run outside a transaction.
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_index(
                Index::create()
                    .table(MerkleTreeInsertion::Table)
                    .name("merkle_tree_insertion_origin_tx_id_idx")
                    .col(MerkleTreeInsertion::OriginTxId)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                CREATE FUNCTION scraper_lock_outbox_source_write()
                RETURNS trigger
                LANGUAGE plpgsql
                AS $$
                BEGIN
                    PERFORM pg_advisory_xact_lock(
                        1559648230, (to_jsonb(NEW) ->> TG_ARGV[0])::integer);
                    RETURN NEW;
                END
                $$;

                CREATE TRIGGER message_lock_outbox
                BEFORE INSERT OR UPDATE ON message
                FOR EACH ROW EXECUTE FUNCTION scraper_lock_outbox_source_write('origin');

                CREATE TRIGGER delivered_message_lock_outbox
                BEFORE INSERT OR UPDATE ON delivered_message
                FOR EACH ROW EXECUTE FUNCTION scraper_lock_outbox_source_write('domain');

                CREATE TRIGGER gas_payment_lock_outbox
                BEFORE INSERT OR UPDATE ON gas_payment
                FOR EACH ROW EXECUTE FUNCTION scraper_lock_outbox_source_write('domain');

                CREATE TRIGGER merkle_tree_insertion_lock_outbox
                BEFORE INSERT OR UPDATE ON merkle_tree_insertion
                FOR EACH ROW EXECUTE FUNCTION scraper_lock_outbox_source_write('domain');
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
                DROP TRIGGER IF EXISTS message_lock_outbox ON message;
                DROP TRIGGER IF EXISTS delivered_message_lock_outbox ON delivered_message;
                DROP TRIGGER IF EXISTS gas_payment_lock_outbox ON gas_payment;
                DROP TRIGGER IF EXISTS merkle_tree_insertion_lock_outbox
                    ON merkle_tree_insertion;
                DROP FUNCTION IF EXISTS scraper_lock_outbox_source_write();
                "#,
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .table(MerkleTreeInsertion::Table)
                    .name("merkle_tree_insertion_origin_tx_id_idx")
                    .to_owned(),
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .table(GasPayment::Table)
                    .name("gas_payment_tx_id_idx")
                    .if_exists()
                    .to_owned(),
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .table(Message::Table)
                    .name("message_origin_tx_id_idx")
                    .if_exists()
                    .to_owned(),
            )
            .await
    }
}
