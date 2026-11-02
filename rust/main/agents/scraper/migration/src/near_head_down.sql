-- Writers must be stopped. Never make provisional data visible as a side effect
-- of removing the flag. Drain it first, or explicitly repair/discard it.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM scraper_head WHERE halted)
    OR EXISTS(SELECT 1 FROM raw_message_dispatch WHERE NOT confirmed)
    OR EXISTS(SELECT 1 FROM delivered_message WHERE NOT confirmed)
    OR EXISTS(SELECT 1 FROM gas_payment WHERE NOT confirmed)
    OR EXISTS(SELECT 1 FROM merkle_tree_insertion WHERE NOT confirmed)
  THEN RAISE EXCEPTION 'Drain or repair near-head history before rollback'; END IF;
END $$;

DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_viewdef('message_view'::regclass,true) INTO definition;
  definition := regexp_replace(definition,'\mconfirmed_delivered_message\M','delivered_message','g');
  definition := regexp_replace(definition,'\mconfirmed_gas_payment\M','gas_payment','g');
  EXECUTE 'CREATE OR REPLACE VIEW message_view AS ' || definition;
  SELECT pg_get_viewdef('total_gas_payment'::regclass,true) INTO definition;
  definition := replace(definition,'confirmed_gas_payment gp','gas_payment gp');
  EXECUTE 'CREATE OR REPLACE VIEW total_gas_payment AS ' || definition;
END $$;
DROP VIEW confirmed_raw_message_dispatch,confirmed_delivered_message,confirmed_gas_payment,confirmed_merkle_tree_insertion;
DROP TRIGGER scraper_provisional_event_notify ON raw_message_dispatch;
DROP TRIGGER scraper_provisional_event_notify ON delivered_message;
DROP TRIGGER scraper_provisional_event_notify ON gas_payment;
DROP TRIGGER scraper_provisional_event_notify ON merkle_tree_insertion;
DROP FUNCTION notify_scraper_provisional_event();
DROP TRIGGER scraper_head_insert_notify ON scraper_head;
DROP TRIGGER scraper_head_update_notify ON scraper_head;
DROP FUNCTION notify_scraper_head();
DROP TRIGGER gas_payment_stream_cursor_assign ON gas_payment;
DROP TRIGGER gas_payment_stream_cursor_confirm ON gas_payment;
CREATE TRIGGER gas_payment_stream_cursor_assign AFTER INSERT ON gas_payment
 FOR EACH ROW EXECUTE FUNCTION assign_gas_payment_stream_cursor();
DROP INDEX raw_dispatch_block_height;
DROP INDEX gas_payment_block_log;
DROP INDEX delivery_unenriched;
DROP INDEX gas_payment_unenriched;
ALTER TABLE raw_message_dispatch DROP COLUMN confirmed, DROP COLUMN log_index, DROP COLUMN transaction_index, DROP COLUMN message_version;
ALTER TABLE delivered_message DROP COLUMN confirmed, DROP COLUMN block_hash, DROP COLUMN block_number, DROP COLUMN transaction_hash, DROP COLUMN transaction_index, DROP COLUMN log_index;
ALTER TABLE gas_payment DROP COLUMN confirmed, DROP COLUMN block_hash, DROP COLUMN block_number, DROP COLUMN transaction_hash, DROP COLUMN transaction_index;
ALTER TABLE merkle_tree_insertion DROP COLUMN confirmed, DROP COLUMN block_hash, DROP COLUMN transaction_hash, DROP COLUMN transaction_index, DROP COLUMN log_index;
DROP TABLE scraper_head;
