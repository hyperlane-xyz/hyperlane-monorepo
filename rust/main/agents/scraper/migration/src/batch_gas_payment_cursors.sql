-- Replace trigger work only: existing cursors and legacy boundaries are untouched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
LOCK TABLE gas_payment IN SHARE ROW EXCLUSIVE MODE;

-- Reserve one range per stream, locking heads in a consistent order. Locks remain
-- held until commit: another writer cannot publish a later range first. Aborts
-- roll back both reservations and mappings. NOTIFY is delivered after commit,
-- when these statement-trigger mappings are visible to subscribers.
-- Separate static queries avoid replanning dynamic SQL for every small batch.
-- Each pending CTE is used twice, so it is materialized without PG12-only syntax.
CREATE FUNCTION assign_inserted_gas_payment_stream_cursors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM new_payments WHERE confirmed) THEN
    RETURN NULL;
  END IF;
  WITH pending AS (SELECT id,domain,interchain_gas_paymaster FROM new_payments WHERE confirmed),
  allocations AS (
    INSERT INTO gas_payment_stream_head AS head
      (domain,interchain_gas_paymaster,legacy_max_id,last_cursor)
    SELECT domain,interchain_gas_paymaster,0,count(*) FROM pending
    GROUP BY domain,interchain_gas_paymaster
    ORDER BY domain,interchain_gas_paymaster
    ON CONFLICT (domain,interchain_gas_paymaster) DO UPDATE
      SET last_cursor = head.last_cursor + EXCLUDED.last_cursor
    RETURNING domain,interchain_gas_paymaster,last_cursor
  )
  INSERT INTO gas_payment_stream_cursor
    (gas_payment_id,domain,interchain_gas_paymaster,stream_cursor)
  SELECT p.id,p.domain,p.interchain_gas_paymaster,
    a.last_cursor - count(*) OVER stream + row_number() OVER ordered_stream
  FROM pending p JOIN allocations a USING(domain,interchain_gas_paymaster)
  WINDOW stream AS (PARTITION BY p.domain,p.interchain_gas_paymaster),
    ordered_stream AS (PARTITION BY p.domain,p.interchain_gas_paymaster ORDER BY p.id);
  RETURN NULL;
END $$;

CREATE FUNCTION assign_confirmed_gas_payment_stream_cursors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Transition tables cannot be combined with UPDATE OF columns. Ignore receipt
  -- enrichment and replay updates, including historical unmapped rows.
  -- Check each transition table independently: a cached small-batch join plan
  -- would otherwise scan pairs of rows when enriching a much larger batch.
  IF NOT EXISTS (SELECT 1 FROM old_payments WHERE NOT confirmed)
     OR NOT EXISTS (SELECT 1 FROM new_payments WHERE confirmed) THEN
    RETURN NULL;
  END IF;
  WITH pending AS (SELECT n.id,n.domain,n.interchain_gas_paymaster FROM new_payments n
    JOIN old_payments o USING(id) WHERE n.confirmed AND NOT o.confirmed),
  allocations AS (
    INSERT INTO gas_payment_stream_head AS head
      (domain,interchain_gas_paymaster,legacy_max_id,last_cursor)
    SELECT domain,interchain_gas_paymaster,0,count(*) FROM pending
    GROUP BY domain,interchain_gas_paymaster
    ORDER BY domain,interchain_gas_paymaster
    ON CONFLICT (domain,interchain_gas_paymaster) DO UPDATE
      SET last_cursor = head.last_cursor + EXCLUDED.last_cursor
    RETURNING domain,interchain_gas_paymaster,last_cursor
  )
  INSERT INTO gas_payment_stream_cursor
    (gas_payment_id,domain,interchain_gas_paymaster,stream_cursor)
  SELECT p.id,p.domain,p.interchain_gas_paymaster,
    a.last_cursor - count(*) OVER stream + row_number() OVER ordered_stream
  FROM pending p JOIN allocations a USING(domain,interchain_gas_paymaster)
  WINDOW stream AS (PARTITION BY p.domain,p.interchain_gas_paymaster),
    ordered_stream AS (PARTITION BY p.domain,p.interchain_gas_paymaster ORDER BY p.id);
  RETURN NULL;
END $$;

DROP TRIGGER gas_payment_stream_cursor_assign ON gas_payment;
DROP TRIGGER gas_payment_stream_cursor_confirm ON gas_payment;
CREATE TRIGGER gas_payment_stream_cursor_assign AFTER INSERT ON gas_payment
  REFERENCING NEW TABLE AS new_payments
  FOR EACH STATEMENT EXECUTE FUNCTION assign_inserted_gas_payment_stream_cursors();
CREATE TRIGGER gas_payment_stream_cursor_confirm AFTER UPDATE ON gas_payment
  REFERENCING OLD TABLE AS old_payments NEW TABLE AS new_payments
  FOR EACH STATEMENT EXECUTE FUNCTION assign_confirmed_gas_payment_stream_cursors();
