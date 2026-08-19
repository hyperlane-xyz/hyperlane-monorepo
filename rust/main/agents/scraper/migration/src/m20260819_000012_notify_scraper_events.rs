use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// The native-sequence index is created separately by
/// `create-raw-dispatch-native-sequence-index`: SeaORM wraps migrations in a
/// transaction, while production tables require `CREATE INDEX CONCURRENTLY`.
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                CREATE OR REPLACE FUNCTION notify_scraper_event()
                RETURNS trigger
                LANGUAGE plpgsql
                AS $$
                DECLARE
                  event_domain bigint;
                BEGIN
                  event_domain := (to_jsonb(NEW) ->> TG_ARGV[1])::bigint;

                  PERFORM pg_notify(
                    'scraper_event',
                    json_build_object(
                      'eventType', TG_ARGV[0],
                      'id', NEW.id::text,
                      'domain', event_domain
                    )::text
                  );

                  RETURN NEW;
                END;
                $$;

                DROP TRIGGER IF EXISTS scraper_event_notify ON raw_message_dispatch;
                CREATE TRIGGER scraper_event_notify
                  AFTER INSERT ON raw_message_dispatch
                  FOR EACH ROW
                  EXECUTE FUNCTION notify_scraper_event('dispatch', 'origin_domain');

                DROP TRIGGER IF EXISTS scraper_event_notify ON delivered_message;
                CREATE TRIGGER scraper_event_notify
                  AFTER INSERT ON delivered_message
                  FOR EACH ROW
                  EXECUTE FUNCTION notify_scraper_event('delivery', 'domain');

                DROP TRIGGER IF EXISTS scraper_event_notify ON gas_payment;
                CREATE TRIGGER scraper_event_notify
                  AFTER INSERT ON gas_payment
                  FOR EACH ROW
                  EXECUTE FUNCTION notify_scraper_event('gas_payment', 'domain');

                DROP TRIGGER IF EXISTS scraper_event_notify ON merkle_tree_insertion;
                CREATE TRIGGER scraper_event_notify
                  AFTER INSERT ON merkle_tree_insertion
                  FOR EACH ROW
                  EXECUTE FUNCTION notify_scraper_event('merkle_tree_insertion', 'domain');

                CREATE OR REPLACE FUNCTION notify_scraper_explorer_event()
                RETURNS trigger
                LANGUAGE plpgsql
                AS $$
                BEGIN
                  PERFORM pg_notify(
                    'scraper_explorer_event',
                    json_build_object('messageId', encode(NEW.msg_id, 'hex'))::text
                  );
                  RETURN NEW;
                END;
                $$;

                DROP TRIGGER IF EXISTS scraper_explorer_event_notify ON "message";
                CREATE TRIGGER scraper_explorer_event_notify
                  AFTER INSERT OR UPDATE ON "message"
                  FOR EACH ROW
                  EXECUTE FUNCTION notify_scraper_explorer_event();

                DROP TRIGGER IF EXISTS scraper_explorer_event_notify ON delivered_message;
                CREATE TRIGGER scraper_explorer_event_notify
                  AFTER INSERT OR UPDATE ON delivered_message
                  FOR EACH ROW
                  EXECUTE FUNCTION notify_scraper_explorer_event();

                DROP TRIGGER IF EXISTS scraper_explorer_event_notify ON gas_payment;
                CREATE TRIGGER scraper_explorer_event_notify
                  AFTER INSERT OR UPDATE ON gas_payment
                  FOR EACH ROW
                  EXECUTE FUNCTION notify_scraper_explorer_event();

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
                DROP TRIGGER IF EXISTS scraper_event_notify ON raw_message_dispatch;
                DROP TRIGGER IF EXISTS scraper_event_notify ON delivered_message;
                DROP TRIGGER IF EXISTS scraper_event_notify ON gas_payment;
                DROP TRIGGER IF EXISTS scraper_event_notify ON merkle_tree_insertion;
                DROP TRIGGER IF EXISTS scraper_explorer_event_notify ON "message";
                DROP TRIGGER IF EXISTS scraper_explorer_event_notify ON delivered_message;
                DROP TRIGGER IF EXISTS scraper_explorer_event_notify ON gas_payment;
                DROP FUNCTION IF EXISTS notify_scraper_event();
                DROP FUNCTION IF EXISTS notify_scraper_explorer_event();
                "#,
            )
            .await?;
        Ok(())
    }
}
