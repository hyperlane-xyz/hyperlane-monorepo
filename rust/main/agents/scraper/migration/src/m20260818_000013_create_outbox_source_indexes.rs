use sea_orm_migration::prelude::*;

use crate::m20230309_000004_create_table_delivered_message::DeliveredMessage;
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
            .create_index(
                Index::create()
                    .table(MerkleTreeInsertion::Table)
                    .name("merkle_tree_insertion_domain_id_idx")
                    .col(MerkleTreeInsertion::Domain)
                    .col(MerkleTreeInsertion::Id)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;

        manager
            .get_connection()
            .execute_unprepared(
                r#"
                CREATE FUNCTION scraper_lock_outbox_domain(source_domain integer)
                RETURNS void
                LANGUAGE sql
                AS $$
                    SELECT pg_advisory_xact_lock(1559648230, source_domain)
                $$;

                CREATE FUNCTION scraper_enqueue_outbox_source()
                RETURNS trigger
                LANGUAGE plpgsql
                AS $$
                DECLARE
                    source_domain integer;
                    source_position bigint;
                    source_tx_id bigint;
                BEGIN
                    source_domain := (to_jsonb(NEW) ->> TG_ARGV[0])::integer;
                    source_tx_id := (to_jsonb(NEW) ->> TG_ARGV[1])::bigint;
                    PERFORM scraper_lock_outbox_domain(source_domain);

                    SELECT block.height
                    INTO STRICT source_position
                    FROM "transaction" source_tx
                    JOIN block ON block.id = source_tx.block_id
                    WHERE source_tx.id = source_tx_id;

                    INSERT INTO outbox
                        (domain, position, event_type, source_table, source_id, time_created)
                    VALUES
                        (source_domain, source_position, TG_ARGV[2], TG_TABLE_NAME,
                         NEW.id, CURRENT_TIMESTAMP)
                    ON CONFLICT (domain, event_type, source_id) DO NOTHING;

                    RETURN NEW;
                END
                $$;

                CREATE TRIGGER message_enqueue_outbox
                AFTER INSERT ON message
                FOR EACH ROW EXECUTE FUNCTION scraper_enqueue_outbox_source(
                    'origin', 'origin_tx_id', 'message_dispatch');

                CREATE TRIGGER delivered_message_enqueue_outbox
                AFTER INSERT ON delivered_message
                FOR EACH ROW EXECUTE FUNCTION scraper_enqueue_outbox_source(
                    'domain', 'destination_tx_id', 'message_delivery');

                CREATE TRIGGER gas_payment_enqueue_outbox
                AFTER INSERT ON gas_payment
                FOR EACH ROW EXECUTE FUNCTION scraper_enqueue_outbox_source(
                    'domain', 'tx_id', 'gas_payment');

                CREATE TRIGGER merkle_tree_insertion_enqueue_outbox
                AFTER INSERT ON merkle_tree_insertion
                FOR EACH ROW EXECUTE FUNCTION scraper_enqueue_outbox_source(
                    'domain', 'origin_tx_id', 'merkle_tree_insertion');
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
                DROP TRIGGER IF EXISTS message_enqueue_outbox ON message;
                DROP TRIGGER IF EXISTS delivered_message_enqueue_outbox ON delivered_message;
                DROP TRIGGER IF EXISTS gas_payment_enqueue_outbox ON gas_payment;
                DROP TRIGGER IF EXISTS merkle_tree_insertion_enqueue_outbox
                    ON merkle_tree_insertion;
                DROP FUNCTION IF EXISTS scraper_enqueue_outbox_source();
                DROP FUNCTION IF EXISTS scraper_lock_outbox_domain(integer);
                "#,
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .table(MerkleTreeInsertion::Table)
                    .name("merkle_tree_insertion_domain_id_idx")
                    .to_owned(),
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
                    .table(DeliveredMessage::Table)
                    .name("delivered_message_domain_id_idx")
                    .if_exists()
                    .to_owned(),
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .table(Message::Table)
                    .name("message_origin_id_idx")
                    .if_exists()
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
