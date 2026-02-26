-- Shovel database-native pipeline (local bootstrap)
--
-- Scope:
-- 1) Raw shovel integration tables (`hl_*`)
-- 2) Scraper-shaped comparison tables (`shovel_*`)
-- 3) Trigger-based projections + reorg delete history capture

-- =============================================================================
-- DOMAIN TABLE (scraper-compatible, minimal bootstrap)
-- =============================================================================
CREATE TABLE IF NOT EXISTS domain (
    id INTEGER PRIMARY KEY,
    time_created TIMESTAMP NOT NULL DEFAULT NOW(),
    time_updated TIMESTAMP NOT NULL DEFAULT NOW(),
    name TEXT NOT NULL,
    native_token TEXT NOT NULL,
    chain_id BIGINT,
    is_test_net BOOLEAN NOT NULL DEFAULT FALSE,
    is_deprecated BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS domain_chain_id_idx ON domain (chain_id);

-- =============================================================================
-- RAW SHOVEL TABLES (written directly by shovel)
-- =============================================================================
-- NOTE:
-- - Shovel also requires ig_name/src_name/block_num/tx_idx/log_idx context
-- - `block_num` + `tx_idx` use numeric to match shovel internal expectations

CREATE TABLE IF NOT EXISTS hl_mailbox_dispatch (
    chain_id INTEGER NOT NULL,
    mailbox BYTEA NOT NULL,
    block_hash BYTEA NOT NULL,
    block_num NUMERIC NOT NULL,
    block_time NUMERIC,
    tx_hash BYTEA NOT NULL,
    tx_idx NUMERIC NOT NULL,
    tx_signer BYTEA,
    tx_to BYTEA,
    tx_nonce NUMERIC,
    tx_input BYTEA,
    tx_gas_price NUMERIC(78, 0),
    tx_max_priority_fee_per_gas NUMERIC(78, 0),
    tx_max_fee_per_gas NUMERIC(78, 0),
    tx_gas_used NUMERIC(78, 0),
    tx_effective_gas_price NUMERIC(78, 0),
    message BYTEA NOT NULL,
    ig_name TEXT NOT NULL,
    src_name TEXT NOT NULL,
    log_idx INTEGER NOT NULL,
    abi_idx INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS hl_mailbox_dispatch_src_tx_log_idx
    ON hl_mailbox_dispatch (src_name, tx_hash, log_idx);

CREATE TABLE IF NOT EXISTS hl_mailbox_dispatch_id (
    chain_id INTEGER NOT NULL,
    mailbox BYTEA NOT NULL,
    block_hash BYTEA NOT NULL,
    block_num NUMERIC NOT NULL,
    block_time NUMERIC,
    tx_hash BYTEA NOT NULL,
    tx_idx NUMERIC NOT NULL,
    tx_signer BYTEA,
    tx_to BYTEA,
    tx_nonce NUMERIC,
    tx_input BYTEA,
    tx_gas_price NUMERIC(78, 0),
    tx_max_priority_fee_per_gas NUMERIC(78, 0),
    tx_max_fee_per_gas NUMERIC(78, 0),
    tx_gas_used NUMERIC(78, 0),
    tx_effective_gas_price NUMERIC(78, 0),
    message_id BYTEA NOT NULL,
    ig_name TEXT NOT NULL,
    src_name TEXT NOT NULL,
    log_idx INTEGER NOT NULL,
    abi_idx INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS hl_mailbox_dispatch_id_src_tx_log_idx
    ON hl_mailbox_dispatch_id (src_name, tx_hash, log_idx);

CREATE TABLE IF NOT EXISTS hl_mailbox_process_id (
    chain_id INTEGER NOT NULL,
    mailbox BYTEA NOT NULL,
    block_hash BYTEA NOT NULL,
    block_num NUMERIC NOT NULL,
    block_time NUMERIC,
    tx_hash BYTEA NOT NULL,
    tx_idx NUMERIC NOT NULL,
    tx_signer BYTEA,
    tx_to BYTEA,
    tx_nonce NUMERIC,
    tx_input BYTEA,
    tx_gas_price NUMERIC(78, 0),
    tx_max_priority_fee_per_gas NUMERIC(78, 0),
    tx_max_fee_per_gas NUMERIC(78, 0),
    tx_gas_used NUMERIC(78, 0),
    tx_effective_gas_price NUMERIC(78, 0),
    message_id BYTEA NOT NULL,
    ig_name TEXT NOT NULL,
    src_name TEXT NOT NULL,
    log_idx INTEGER NOT NULL,
    abi_idx INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS hl_mailbox_process_id_src_tx_log_idx
    ON hl_mailbox_process_id (src_name, tx_hash, log_idx);

CREATE TABLE IF NOT EXISTS hl_igp_gas_payment (
    chain_id INTEGER NOT NULL,
    interchain_gas_paymaster BYTEA NOT NULL,
    block_hash BYTEA NOT NULL,
    block_num NUMERIC NOT NULL,
    block_time NUMERIC,
    tx_hash BYTEA NOT NULL,
    tx_idx NUMERIC NOT NULL,
    tx_signer BYTEA,
    tx_to BYTEA,
    tx_nonce NUMERIC,
    tx_input BYTEA,
    tx_gas_price NUMERIC(78, 0),
    tx_max_priority_fee_per_gas NUMERIC(78, 0),
    tx_max_fee_per_gas NUMERIC(78, 0),
    tx_gas_used NUMERIC(78, 0),
    tx_effective_gas_price NUMERIC(78, 0),
    message_id BYTEA NOT NULL,
    destination_domain NUMERIC NOT NULL,
    gas_amount NUMERIC(78, 0) NOT NULL,
    payment NUMERIC(78, 0) NOT NULL,
    ig_name TEXT NOT NULL,
    src_name TEXT NOT NULL,
    log_idx INTEGER NOT NULL,
    abi_idx INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS hl_igp_gas_payment_src_tx_log_idx
    ON hl_igp_gas_payment (src_name, tx_hash, log_idx);

CREATE TABLE IF NOT EXISTS hl_merkle_insert (
    chain_id INTEGER NOT NULL,
    merkle_tree_hook BYTEA NOT NULL,
    block_hash BYTEA NOT NULL,
    block_num NUMERIC NOT NULL,
    block_time NUMERIC,
    tx_hash BYTEA NOT NULL,
    tx_idx NUMERIC NOT NULL,
    tx_signer BYTEA,
    tx_to BYTEA,
    tx_nonce NUMERIC,
    tx_input BYTEA,
    tx_gas_price NUMERIC(78, 0),
    tx_max_priority_fee_per_gas NUMERIC(78, 0),
    tx_max_fee_per_gas NUMERIC(78, 0),
    tx_gas_used NUMERIC(78, 0),
    tx_effective_gas_price NUMERIC(78, 0),
    message_id BYTEA NOT NULL,
    leaf_index NUMERIC NOT NULL,
    ig_name TEXT NOT NULL,
    src_name TEXT NOT NULL,
    log_idx INTEGER NOT NULL,
    abi_idx INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS hl_merkle_insert_src_tx_log_idx
    ON hl_merkle_insert (src_name, tx_hash, log_idx);

-- =============================================================================
-- SCRAPER-SHAPED SHOVEL TABLES (comparison targets)
-- =============================================================================

CREATE TABLE IF NOT EXISTS shovel_block (
    id BIGSERIAL PRIMARY KEY,
    time_created TIMESTAMP NOT NULL DEFAULT NOW(),
    domain INTEGER NOT NULL REFERENCES domain(id),
    hash BYTEA UNIQUE NOT NULL,
    height BIGINT NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    UNIQUE (domain, height)
);

CREATE INDEX IF NOT EXISTS shovel_block_hash_idx
    ON shovel_block USING HASH (hash);
CREATE INDEX IF NOT EXISTS shovel_block_timestamp_idx
    ON shovel_block (timestamp);
CREATE INDEX IF NOT EXISTS shovel_block_domain_height_idx
    ON shovel_block (domain, height);

CREATE TABLE IF NOT EXISTS shovel_transaction (
    id BIGSERIAL PRIMARY KEY,
    time_created TIMESTAMP NOT NULL DEFAULT NOW(),
    hash BYTEA UNIQUE NOT NULL,
    block_id BIGINT NOT NULL REFERENCES shovel_block(id),
    gas_limit NUMERIC(78, 0) NOT NULL,
    max_priority_fee_per_gas NUMERIC(78, 0),
    max_fee_per_gas NUMERIC(78, 0),
    gas_price NUMERIC(78, 0),
    effective_gas_price NUMERIC(78, 0),
    nonce BIGINT NOT NULL,
    sender BYTEA NOT NULL,
    recipient BYTEA,
    gas_used NUMERIC(78, 0) NOT NULL,
    cumulative_gas_used NUMERIC(78, 0) NOT NULL,
    raw_input_data BYTEA
);

CREATE INDEX IF NOT EXISTS shovel_transaction_hash_idx
    ON shovel_transaction USING HASH (hash);
CREATE INDEX IF NOT EXISTS shovel_transaction_sender_idx
    ON shovel_transaction USING HASH (sender);
CREATE INDEX IF NOT EXISTS shovel_transaction_block_idx
    ON shovel_transaction (block_id);

CREATE TABLE IF NOT EXISTS shovel_message (
    id BIGSERIAL PRIMARY KEY,
    time_created TIMESTAMP NOT NULL DEFAULT NOW(),
    msg_id BYTEA NOT NULL,
    origin INTEGER NOT NULL REFERENCES domain(id),
    destination INTEGER NOT NULL REFERENCES domain(id),
    nonce INTEGER NOT NULL,
    sender BYTEA NOT NULL,
    recipient BYTEA NOT NULL,
    msg_body BYTEA,
    origin_mailbox BYTEA NOT NULL,
    origin_tx_id BIGINT NOT NULL REFERENCES shovel_transaction(id),
    UNIQUE (origin, origin_mailbox, nonce)
);

CREATE INDEX IF NOT EXISTS shovel_message_sender_idx
    ON shovel_message USING HASH (sender);
CREATE INDEX IF NOT EXISTS shovel_message_recipient_idx
    ON shovel_message USING HASH (recipient);
CREATE INDEX IF NOT EXISTS shovel_message_msg_id_idx
    ON shovel_message USING HASH (msg_id);
CREATE INDEX IF NOT EXISTS shovel_message_destination_idx
    ON shovel_message (destination);

CREATE TABLE IF NOT EXISTS shovel_delivered_message (
    id BIGSERIAL PRIMARY KEY,
    time_created TIMESTAMP NOT NULL DEFAULT NOW(),
    msg_id BYTEA UNIQUE NOT NULL,
    domain INTEGER NOT NULL REFERENCES domain(id),
    destination_mailbox BYTEA NOT NULL,
    destination_tx_id BIGINT NOT NULL REFERENCES shovel_transaction(id),
    sequence BIGINT
);

CREATE INDEX IF NOT EXISTS shovel_delivered_message_domain_destination_mailbox_idx
    ON shovel_delivered_message (domain, destination_mailbox);
CREATE INDEX IF NOT EXISTS shovel_delivered_message_domain_destination_mailbox_sequence_idx
    ON shovel_delivered_message (domain, destination_mailbox, sequence);
CREATE INDEX IF NOT EXISTS shovel_delivered_message_tx_idx
    ON shovel_delivered_message (destination_tx_id);
CREATE INDEX IF NOT EXISTS shovel_delivered_message_msg_id_idx
    ON shovel_delivered_message USING HASH (msg_id);

CREATE TABLE IF NOT EXISTS shovel_gas_payment (
    id BIGSERIAL PRIMARY KEY,
    time_created TIMESTAMP NOT NULL DEFAULT NOW(),
    domain INTEGER NOT NULL REFERENCES domain(id),
    msg_id BYTEA NOT NULL,
    payment NUMERIC(78, 0) NOT NULL,
    gas_amount NUMERIC(78, 0) NOT NULL,
    tx_id BIGINT NOT NULL REFERENCES shovel_transaction(id),
    log_index BIGINT NOT NULL,
    origin INTEGER NOT NULL REFERENCES domain(id),
    destination INTEGER NOT NULL REFERENCES domain(id),
    interchain_gas_paymaster BYTEA NOT NULL,
    sequence BIGINT,
    UNIQUE (msg_id, tx_id, log_index)
);

CREATE INDEX IF NOT EXISTS shovel_gas_payment_msg_id_idx
    ON shovel_gas_payment USING HASH (msg_id);
CREATE INDEX IF NOT EXISTS shovel_gas_payment_domain_id_idx
    ON shovel_gas_payment (domain, id);
CREATE INDEX IF NOT EXISTS shovel_gas_payment_origin_id_idx
    ON shovel_gas_payment (origin, id);
CREATE INDEX IF NOT EXISTS shovel_gas_payment_origin_interchain_gas_paymaster_sequence_idx
    ON shovel_gas_payment (origin, interchain_gas_paymaster, sequence);

CREATE TABLE IF NOT EXISTS shovel_raw_message_dispatch (
    id BIGSERIAL PRIMARY KEY,
    time_created TIMESTAMP NOT NULL DEFAULT NOW(),
    time_updated TIMESTAMP NOT NULL DEFAULT NOW(),
    msg_id BYTEA UNIQUE NOT NULL,
    origin_tx_hash BYTEA NOT NULL,
    origin_block_hash BYTEA NOT NULL,
    origin_block_height BIGINT NOT NULL,
    nonce INTEGER NOT NULL,
    origin_domain INTEGER NOT NULL,
    destination_domain INTEGER NOT NULL,
    sender BYTEA NOT NULL,
    recipient BYTEA NOT NULL,
    origin_mailbox BYTEA NOT NULL
);

CREATE INDEX IF NOT EXISTS shovel_raw_message_dispatch_origin_domain_idx
    ON shovel_raw_message_dispatch (origin_domain);
CREATE INDEX IF NOT EXISTS shovel_raw_message_dispatch_destination_domain_idx
    ON shovel_raw_message_dispatch (destination_domain);
CREATE INDEX IF NOT EXISTS shovel_raw_message_dispatch_origin_tx_hash_idx
    ON shovel_raw_message_dispatch USING HASH (origin_tx_hash);

CREATE TABLE IF NOT EXISTS shovel_merkle_tree_insertion (
    id BIGSERIAL PRIMARY KEY,
    time_created TIMESTAMP NOT NULL DEFAULT NOW(),
    domain INTEGER NOT NULL REFERENCES domain(id),
    leaf_index INTEGER NOT NULL,
    message_id BYTEA NOT NULL,
    merkle_tree_hook BYTEA NOT NULL,
    tx_id BIGINT NOT NULL REFERENCES shovel_transaction(id),
    log_index INTEGER NOT NULL,
    UNIQUE (domain, merkle_tree_hook, leaf_index)
);

CREATE INDEX IF NOT EXISTS shovel_merkle_tree_insertion_domain_leaf_idx
    ON shovel_merkle_tree_insertion (domain, leaf_index);
CREATE INDEX IF NOT EXISTS shovel_merkle_tree_insertion_message_id_idx
    ON shovel_merkle_tree_insertion USING HASH (message_id);

-- Reorg/orphan history for raw-row deletes caused by shovel unwind.
CREATE TABLE IF NOT EXISTS shovel_orphaned_event (
    id BIGSERIAL PRIMARY KEY,
    time_deleted TIMESTAMP NOT NULL DEFAULT NOW(),
    raw_table TEXT NOT NULL,
    src_name TEXT,
    chain_id INTEGER,
    block_num NUMERIC,
    tx_hash TEXT,
    log_idx INTEGER,
    msg_id TEXT,
    row_data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS shovel_orphaned_event_time_idx
    ON shovel_orphaned_event (time_deleted);
CREATE INDEX IF NOT EXISTS shovel_orphaned_event_raw_table_idx
    ON shovel_orphaned_event (raw_table);
CREATE INDEX IF NOT EXISTS shovel_orphaned_event_msg_idx
    ON shovel_orphaned_event (msg_id);

-- =============================================================================
-- HELPERS
-- =============================================================================

CREATE OR REPLACE FUNCTION hyperlane_shovel_parse_u32_be(
    p_bytes BYTEA,
    p_offset INTEGER
) RETURNS INTEGER AS $$
BEGIN
    IF p_bytes IS NULL OR octet_length(p_bytes) < p_offset + 4 THEN
        RETURN NULL;
    END IF;

    RETURN
        (get_byte(p_bytes, p_offset) << 24)
      + (get_byte(p_bytes, p_offset + 1) << 16)
      + (get_byte(p_bytes, p_offset + 2) << 8)
      + get_byte(p_bytes, p_offset + 3);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION hyperlane_shovel_find_domain(
    p_chain_id INTEGER
) RETURNS INTEGER AS $$
DECLARE
    v_domain INTEGER;
BEGIN
    SELECT d.id INTO v_domain
    FROM domain d
    WHERE d.chain_id = p_chain_id OR d.id = p_chain_id
    ORDER BY CASE WHEN d.chain_id = p_chain_id THEN 0 ELSE 1 END
    LIMIT 1;

    RETURN v_domain;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_ensure_domain(
    p_chain_id INTEGER,
    p_src_name TEXT
) RETURNS INTEGER AS $$
DECLARE
    v_domain INTEGER;
BEGIN
    v_domain := hyperlane_shovel_find_domain(p_chain_id);
    IF v_domain IS NOT NULL THEN
        RETURN v_domain;
    END IF;

    INSERT INTO domain (
        id,
        time_updated,
        name,
        native_token,
        chain_id,
        is_test_net,
        is_deprecated
    ) VALUES (
        p_chain_id,
        NOW(),
        COALESCE(NULLIF(p_src_name, ''), CONCAT('chain-', p_chain_id::TEXT)),
        'UNK',
        p_chain_id,
        TRUE,
        FALSE
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN p_chain_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_ensure_domain_id(
    p_domain_id INTEGER
) RETURNS INTEGER AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM domain WHERE id = p_domain_id) THEN
        RETURN p_domain_id;
    END IF;

    INSERT INTO domain (
        id,
        time_updated,
        name,
        native_token,
        chain_id,
        is_test_net,
        is_deprecated
    ) VALUES (
        p_domain_id,
        NOW(),
        CONCAT('domain-', p_domain_id::TEXT),
        'UNK',
        NULL,
        TRUE,
        FALSE
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN p_domain_id;
END;
$$ LANGUAGE plpgsql;

-- Match Rust scraper address_to_bytes(): if the first 12 bytes are zero
-- (EVM address in H256), return only the last 20 bytes; otherwise keep all 32.
CREATE OR REPLACE FUNCTION hyperlane_shovel_address_to_bytes(
    p_h256 BYTEA
) RETURNS BYTEA AS $$
BEGIN
    IF p_h256 IS NULL OR octet_length(p_h256) != 32 THEN
        RETURN p_h256;
    END IF;

    IF substring(p_h256 FROM 1 FOR 12) = E'\\x000000000000000000000000'::BYTEA THEN
        RETURN substring(p_h256 FROM 13 FOR 20);
    END IF;

    RETURN p_h256;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION hyperlane_shovel_unix_to_timestamp(
    p_unix NUMERIC
) RETURNS TIMESTAMP AS $$
BEGIN
    IF p_unix IS NULL THEN
        RETURN NOW();
    END IF;

    RETURN to_timestamp(p_unix::DOUBLE PRECISION)::TIMESTAMP;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION hyperlane_shovel_upsert_block(
    p_domain INTEGER,
    p_block_hash BYTEA,
    p_block_num NUMERIC,
    p_block_time NUMERIC
) RETURNS BIGINT AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO shovel_block (domain, hash, height, timestamp)
    VALUES (
        p_domain,
        p_block_hash,
        p_block_num::BIGINT,
        hyperlane_shovel_unix_to_timestamp(p_block_time)
    )
    ON CONFLICT (domain, height) DO UPDATE
    SET
        hash = EXCLUDED.hash,
        timestamp = EXCLUDED.timestamp
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_upsert_transaction(
    p_block_id BIGINT,
    p_tx_hash BYTEA,
    p_tx_sender BYTEA,
    p_tx_recipient BYTEA,
    p_tx_nonce NUMERIC,
    p_tx_input BYTEA,
    p_tx_gas_price NUMERIC,
    p_tx_max_priority_fee_per_gas NUMERIC,
    p_tx_max_fee_per_gas NUMERIC,
    p_tx_gas_used NUMERIC,
    p_tx_effective_gas_price NUMERIC
) RETURNS BIGINT AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO shovel_transaction (
        hash,
        block_id,
        gas_limit,
        max_priority_fee_per_gas,
        max_fee_per_gas,
        gas_price,
        effective_gas_price,
        nonce,
        sender,
        recipient,
        gas_used,
        cumulative_gas_used,
        raw_input_data
    ) VALUES (
        p_tx_hash,
        p_block_id,
        0,
        p_tx_max_priority_fee_per_gas,
        p_tx_max_fee_per_gas,
        p_tx_gas_price,
        p_tx_effective_gas_price,
        COALESCE(p_tx_nonce, 0)::BIGINT,
        COALESCE(
            p_tx_sender,
            E'\\x0000000000000000000000000000000000000000'::BYTEA
        ),
        p_tx_recipient,
        COALESCE(p_tx_gas_used, 0),
        COALESCE(p_tx_gas_used, 0),
        p_tx_input
    )
    ON CONFLICT (hash) DO UPDATE
    SET
        block_id = EXCLUDED.block_id,
        max_priority_fee_per_gas = EXCLUDED.max_priority_fee_per_gas,
        max_fee_per_gas = EXCLUDED.max_fee_per_gas,
        gas_price = EXCLUDED.gas_price,
        effective_gas_price = EXCLUDED.effective_gas_price,
        nonce = EXCLUDED.nonce,
        sender = EXCLUDED.sender,
        recipient = EXCLUDED.recipient,
        gas_used = EXCLUDED.gas_used,
        cumulative_gas_used = EXCLUDED.cumulative_gas_used,
        raw_input_data = EXCLUDED.raw_input_data
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_prune_transaction(
    p_tx_hash BYTEA
) RETURNS VOID AS $$
DECLARE
    v_tx_id BIGINT;
    v_block_id BIGINT;
    v_has_refs BOOLEAN;
BEGIN
    SELECT t.id, t.block_id INTO v_tx_id, v_block_id
    FROM shovel_transaction t
    WHERE t.hash = p_tx_hash;

    IF v_tx_id IS NULL THEN
        RETURN;
    END IF;

    SELECT
        EXISTS (SELECT 1 FROM shovel_message WHERE origin_tx_id = v_tx_id)
        OR EXISTS (
            SELECT 1 FROM shovel_delivered_message WHERE destination_tx_id = v_tx_id
        )
        OR EXISTS (SELECT 1 FROM shovel_gas_payment WHERE tx_id = v_tx_id)
        OR EXISTS (SELECT 1 FROM shovel_merkle_tree_insertion WHERE tx_id = v_tx_id)
    INTO v_has_refs;

    IF v_has_refs THEN
        RETURN;
    END IF;

    DELETE FROM shovel_transaction WHERE id = v_tx_id;

    DELETE FROM shovel_block
    WHERE id = v_block_id
      AND NOT EXISTS (
        SELECT 1 FROM shovel_transaction t WHERE t.block_id = v_block_id
      );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_capture_orphan(
    p_raw_table TEXT,
    p_row JSONB
) RETURNS VOID AS $$
BEGIN
    INSERT INTO shovel_orphaned_event (
        raw_table,
        src_name,
        chain_id,
        block_num,
        tx_hash,
        log_idx,
        msg_id,
        row_data
    ) VALUES (
        p_raw_table,
        p_row->>'src_name',
        CASE WHEN p_row ? 'chain_id' THEN (p_row->>'chain_id')::INTEGER ELSE NULL END,
        CASE WHEN p_row ? 'block_num' THEN (p_row->>'block_num')::NUMERIC ELSE NULL END,
        p_row->>'tx_hash',
        CASE WHEN p_row ? 'log_idx' THEN (p_row->>'log_idx')::INTEGER ELSE NULL END,
        COALESCE(p_row->>'message_id', p_row->>'msg_id'),
        p_row
    );
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- PROJECTIONS (INSERT PATH)
-- =============================================================================

CREATE OR REPLACE FUNCTION hyperlane_shovel_project_dispatch_row(
    p_dispatch hl_mailbox_dispatch,
    p_message_id BYTEA
) RETURNS VOID AS $$
DECLARE
    v_origin_domain INTEGER;
    v_destination_domain INTEGER;
    v_block_id BIGINT;
    v_tx_id BIGINT;
    v_nonce INTEGER;
    v_sender BYTEA;
    v_recipient BYTEA;
    v_message_body BYTEA;
BEGIN
    IF p_message_id IS NULL OR p_dispatch.message IS NULL THEN
        RETURN;
    END IF;

    IF octet_length(p_dispatch.message) < 77 THEN
        RETURN;
    END IF;

    v_nonce := hyperlane_shovel_parse_u32_be(p_dispatch.message, 1);
    v_destination_domain := hyperlane_shovel_parse_u32_be(p_dispatch.message, 41);

    IF v_nonce IS NULL OR v_destination_domain IS NULL THEN
        RETURN;
    END IF;

    v_origin_domain := hyperlane_shovel_ensure_domain(
        p_dispatch.chain_id,
        p_dispatch.src_name
    );
    v_destination_domain := hyperlane_shovel_ensure_domain_id(v_destination_domain);

    v_block_id := hyperlane_shovel_upsert_block(
        v_origin_domain,
        p_dispatch.block_hash,
        p_dispatch.block_num,
        p_dispatch.block_time
    );

    v_tx_id := hyperlane_shovel_upsert_transaction(
        v_block_id,
        p_dispatch.tx_hash,
        p_dispatch.tx_signer,
        p_dispatch.tx_to,
        p_dispatch.tx_nonce,
        p_dispatch.tx_input,
        p_dispatch.tx_gas_price,
        p_dispatch.tx_max_priority_fee_per_gas,
        p_dispatch.tx_max_fee_per_gas,
        p_dispatch.tx_gas_used,
        p_dispatch.tx_effective_gas_price
    );

    v_sender := hyperlane_shovel_address_to_bytes(
        substring(p_dispatch.message FROM 10 FOR 32)
    );
    v_recipient := hyperlane_shovel_address_to_bytes(
        substring(p_dispatch.message FROM 46 FOR 32)
    );

    IF octet_length(p_dispatch.message) > 77 THEN
        v_message_body := substring(p_dispatch.message FROM 78);
    ELSE
        v_message_body := E'\\x'::BYTEA;
    END IF;

    INSERT INTO shovel_message (
        msg_id,
        origin,
        destination,
        nonce,
        sender,
        recipient,
        msg_body,
        origin_mailbox,
        origin_tx_id
    ) VALUES (
        p_message_id,
        v_origin_domain,
        v_destination_domain,
        v_nonce,
        v_sender,
        v_recipient,
        v_message_body,
        p_dispatch.mailbox,
        v_tx_id
    )
    ON CONFLICT (origin, origin_mailbox, nonce) DO UPDATE
    SET
        msg_id = EXCLUDED.msg_id,
        destination = EXCLUDED.destination,
        sender = EXCLUDED.sender,
        recipient = EXCLUDED.recipient,
        msg_body = EXCLUDED.msg_body,
        origin_tx_id = EXCLUDED.origin_tx_id;

    INSERT INTO shovel_raw_message_dispatch (
        msg_id,
        origin_tx_hash,
        origin_block_hash,
        origin_block_height,
        nonce,
        origin_domain,
        destination_domain,
        sender,
        recipient,
        origin_mailbox,
        time_updated
    ) VALUES (
        p_message_id,
        p_dispatch.tx_hash,
        p_dispatch.block_hash,
        p_dispatch.block_num::BIGINT,
        v_nonce,
        v_origin_domain,
        v_destination_domain,
        v_sender,
        v_recipient,
        p_dispatch.mailbox,
        NOW()
    )
    ON CONFLICT (msg_id) DO UPDATE
    SET
        time_updated = NOW(),
        origin_tx_hash = EXCLUDED.origin_tx_hash,
        origin_block_hash = EXCLUDED.origin_block_hash,
        origin_block_height = EXCLUDED.origin_block_height,
        nonce = EXCLUDED.nonce,
        origin_domain = EXCLUDED.origin_domain,
        destination_domain = EXCLUDED.destination_domain,
        sender = EXCLUDED.sender,
        recipient = EXCLUDED.recipient,
        origin_mailbox = EXCLUDED.origin_mailbox;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_try_project_dispatch(
    p_src_name TEXT,
    p_tx_hash BYTEA,
    p_dispatch_log_idx INTEGER
) RETURNS VOID AS $$
DECLARE
    v_dispatch hl_mailbox_dispatch%ROWTYPE;
    v_message_id BYTEA;
BEGIN
    SELECT d.*
    INTO v_dispatch
    FROM hl_mailbox_dispatch d
    WHERE d.src_name = p_src_name
      AND d.tx_hash = p_tx_hash
      AND d.log_idx = p_dispatch_log_idx
    ORDER BY d.block_num DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT di.message_id
    INTO v_message_id
    FROM hl_mailbox_dispatch_id di
    WHERE di.src_name = v_dispatch.src_name
      AND di.tx_hash = v_dispatch.tx_hash
      AND di.log_idx = v_dispatch.log_idx + 1
    ORDER BY di.block_num DESC
    LIMIT 1;

    IF v_message_id IS NULL THEN
        RETURN;
    END IF;

    PERFORM hyperlane_shovel_project_dispatch_row(v_dispatch, v_message_id);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_on_dispatch_insert()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM hyperlane_shovel_try_project_dispatch(NEW.src_name, NEW.tx_hash, NEW.log_idx);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_on_dispatch_id_insert()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM hyperlane_shovel_try_project_dispatch(
        NEW.src_name,
        NEW.tx_hash,
        NEW.log_idx - 1
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_on_process_id_insert()
RETURNS TRIGGER AS $$
DECLARE
    v_domain INTEGER;
    v_block_id BIGINT;
    v_tx_id BIGINT;
BEGIN
    v_domain := hyperlane_shovel_ensure_domain(NEW.chain_id, NEW.src_name);

    v_block_id := hyperlane_shovel_upsert_block(
        v_domain,
        NEW.block_hash,
        NEW.block_num,
        NEW.block_time
    );

    v_tx_id := hyperlane_shovel_upsert_transaction(
        v_block_id,
        NEW.tx_hash,
        NEW.tx_signer,
        NEW.tx_to,
        NEW.tx_nonce,
        NEW.tx_input,
        NEW.tx_gas_price,
        NEW.tx_max_priority_fee_per_gas,
        NEW.tx_max_fee_per_gas,
        NEW.tx_gas_used,
        NEW.tx_effective_gas_price
    );

    INSERT INTO shovel_delivered_message (
        msg_id,
        domain,
        destination_mailbox,
        destination_tx_id,
        sequence
    ) VALUES (
        NEW.message_id,
        v_domain,
        NEW.mailbox,
        v_tx_id,
        NULL
    )
    ON CONFLICT (msg_id) DO UPDATE
    SET
        time_created = NOW(),
        domain = EXCLUDED.domain,
        destination_mailbox = EXCLUDED.destination_mailbox,
        destination_tx_id = EXCLUDED.destination_tx_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_on_gas_payment_insert()
RETURNS TRIGGER AS $$
DECLARE
    v_domain INTEGER;
    v_destination INTEGER;
    v_block_id BIGINT;
    v_tx_id BIGINT;
BEGIN
    v_domain := hyperlane_shovel_ensure_domain(NEW.chain_id, NEW.src_name);
    v_destination := hyperlane_shovel_ensure_domain_id(NEW.destination_domain::INTEGER);

    v_block_id := hyperlane_shovel_upsert_block(
        v_domain,
        NEW.block_hash,
        NEW.block_num,
        NEW.block_time
    );

    v_tx_id := hyperlane_shovel_upsert_transaction(
        v_block_id,
        NEW.tx_hash,
        NEW.tx_signer,
        NEW.tx_to,
        NEW.tx_nonce,
        NEW.tx_input,
        NEW.tx_gas_price,
        NEW.tx_max_priority_fee_per_gas,
        NEW.tx_max_fee_per_gas,
        NEW.tx_gas_used,
        NEW.tx_effective_gas_price
    );

    INSERT INTO shovel_gas_payment (
        domain,
        msg_id,
        payment,
        gas_amount,
        tx_id,
        log_index,
        origin,
        destination,
        interchain_gas_paymaster,
        sequence
    ) VALUES (
        v_domain,
        NEW.message_id,
        NEW.payment,
        NEW.gas_amount,
        v_tx_id,
        NEW.log_idx,
        v_domain,
        v_destination,
        NEW.interchain_gas_paymaster,
        NULL
    )
    ON CONFLICT (msg_id, tx_id, log_index) DO UPDATE
    SET
        time_created = NOW(),
        payment = EXCLUDED.payment,
        gas_amount = EXCLUDED.gas_amount,
        origin = EXCLUDED.origin,
        destination = EXCLUDED.destination,
        interchain_gas_paymaster = EXCLUDED.interchain_gas_paymaster;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_on_merkle_insert()
RETURNS TRIGGER AS $$
DECLARE
    v_domain INTEGER;
    v_block_id BIGINT;
    v_tx_id BIGINT;
BEGIN
    v_domain := hyperlane_shovel_ensure_domain(NEW.chain_id, NEW.src_name);

    v_block_id := hyperlane_shovel_upsert_block(
        v_domain,
        NEW.block_hash,
        NEW.block_num,
        NEW.block_time
    );

    v_tx_id := hyperlane_shovel_upsert_transaction(
        v_block_id,
        NEW.tx_hash,
        NEW.tx_signer,
        NEW.tx_to,
        NEW.tx_nonce,
        NEW.tx_input,
        NEW.tx_gas_price,
        NEW.tx_max_priority_fee_per_gas,
        NEW.tx_max_fee_per_gas,
        NEW.tx_gas_used,
        NEW.tx_effective_gas_price
    );

    INSERT INTO shovel_merkle_tree_insertion (
        domain,
        leaf_index,
        message_id,
        merkle_tree_hook,
        tx_id,
        log_index
    ) VALUES (
        v_domain,
        NEW.leaf_index::INTEGER,
        NEW.message_id,
        NEW.merkle_tree_hook,
        v_tx_id,
        NEW.log_idx
    )
    ON CONFLICT (domain, merkle_tree_hook, leaf_index) DO UPDATE
    SET
        message_id = EXCLUDED.message_id,
        tx_id = EXCLUDED.tx_id,
        log_index = EXCLUDED.log_index;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- PROJECTIONS (DELETE PATH + ORPHAN HISTORY)
-- =============================================================================

CREATE OR REPLACE FUNCTION hyperlane_shovel_on_dispatch_delete()
RETURNS TRIGGER AS $$
DECLARE
    v_message_id BYTEA;
BEGIN
    PERFORM hyperlane_shovel_capture_orphan('hl_mailbox_dispatch', to_jsonb(OLD));

    SELECT di.message_id INTO v_message_id
    FROM hl_mailbox_dispatch_id di
    WHERE di.src_name = OLD.src_name
      AND di.tx_hash = OLD.tx_hash
      AND di.log_idx = OLD.log_idx + 1
    ORDER BY di.block_num DESC
    LIMIT 1;

    IF v_message_id IS NOT NULL THEN
        DELETE FROM shovel_message WHERE msg_id = v_message_id;
        DELETE FROM shovel_raw_message_dispatch WHERE msg_id = v_message_id;
    END IF;

    PERFORM hyperlane_shovel_prune_transaction(OLD.tx_hash);
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_on_dispatch_id_delete()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM hyperlane_shovel_capture_orphan('hl_mailbox_dispatch_id', to_jsonb(OLD));

    DELETE FROM shovel_message WHERE msg_id = OLD.message_id;
    DELETE FROM shovel_raw_message_dispatch WHERE msg_id = OLD.message_id;

    PERFORM hyperlane_shovel_prune_transaction(OLD.tx_hash);
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_on_process_id_delete()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM hyperlane_shovel_capture_orphan('hl_mailbox_process_id', to_jsonb(OLD));

    DELETE FROM shovel_delivered_message WHERE msg_id = OLD.message_id;

    PERFORM hyperlane_shovel_prune_transaction(OLD.tx_hash);
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_on_gas_payment_delete()
RETURNS TRIGGER AS $$
DECLARE
    v_tx_id BIGINT;
BEGIN
    PERFORM hyperlane_shovel_capture_orphan('hl_igp_gas_payment', to_jsonb(OLD));

    SELECT t.id INTO v_tx_id
    FROM shovel_transaction t
    WHERE t.hash = OLD.tx_hash;

    IF v_tx_id IS NOT NULL THEN
        DELETE FROM shovel_gas_payment gp
        WHERE gp.msg_id = OLD.message_id
          AND gp.tx_id = v_tx_id
          AND gp.log_index = OLD.log_idx;
    END IF;

    PERFORM hyperlane_shovel_prune_transaction(OLD.tx_hash);
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hyperlane_shovel_on_merkle_delete()
RETURNS TRIGGER AS $$
DECLARE
    v_domain INTEGER;
BEGIN
    PERFORM hyperlane_shovel_capture_orphan('hl_merkle_insert', to_jsonb(OLD));

    v_domain := hyperlane_shovel_find_domain(OLD.chain_id);

    IF v_domain IS NOT NULL THEN
        DELETE FROM shovel_merkle_tree_insertion m
        WHERE m.domain = v_domain
          AND m.merkle_tree_hook = OLD.merkle_tree_hook
          AND m.leaf_index = OLD.leaf_index::INTEGER;
    END IF;

    PERFORM hyperlane_shovel_prune_transaction(OLD.tx_hash);
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- TRIGGERS
-- =============================================================================

DROP TRIGGER IF EXISTS tr_hl_mailbox_dispatch_insert ON hl_mailbox_dispatch;
CREATE TRIGGER tr_hl_mailbox_dispatch_insert
AFTER INSERT ON hl_mailbox_dispatch
FOR EACH ROW EXECUTE FUNCTION hyperlane_shovel_on_dispatch_insert();

DROP TRIGGER IF EXISTS tr_hl_mailbox_dispatch_delete ON hl_mailbox_dispatch;
CREATE TRIGGER tr_hl_mailbox_dispatch_delete
AFTER DELETE ON hl_mailbox_dispatch
FOR EACH ROW EXECUTE FUNCTION hyperlane_shovel_on_dispatch_delete();

DROP TRIGGER IF EXISTS tr_hl_mailbox_dispatch_id_insert ON hl_mailbox_dispatch_id;
CREATE TRIGGER tr_hl_mailbox_dispatch_id_insert
AFTER INSERT ON hl_mailbox_dispatch_id
FOR EACH ROW EXECUTE FUNCTION hyperlane_shovel_on_dispatch_id_insert();

DROP TRIGGER IF EXISTS tr_hl_mailbox_dispatch_id_delete ON hl_mailbox_dispatch_id;
CREATE TRIGGER tr_hl_mailbox_dispatch_id_delete
AFTER DELETE ON hl_mailbox_dispatch_id
FOR EACH ROW EXECUTE FUNCTION hyperlane_shovel_on_dispatch_id_delete();

DROP TRIGGER IF EXISTS tr_hl_mailbox_process_id_insert ON hl_mailbox_process_id;
CREATE TRIGGER tr_hl_mailbox_process_id_insert
AFTER INSERT ON hl_mailbox_process_id
FOR EACH ROW EXECUTE FUNCTION hyperlane_shovel_on_process_id_insert();

DROP TRIGGER IF EXISTS tr_hl_mailbox_process_id_delete ON hl_mailbox_process_id;
CREATE TRIGGER tr_hl_mailbox_process_id_delete
AFTER DELETE ON hl_mailbox_process_id
FOR EACH ROW EXECUTE FUNCTION hyperlane_shovel_on_process_id_delete();

DROP TRIGGER IF EXISTS tr_hl_igp_gas_payment_insert ON hl_igp_gas_payment;
CREATE TRIGGER tr_hl_igp_gas_payment_insert
AFTER INSERT ON hl_igp_gas_payment
FOR EACH ROW EXECUTE FUNCTION hyperlane_shovel_on_gas_payment_insert();

DROP TRIGGER IF EXISTS tr_hl_igp_gas_payment_delete ON hl_igp_gas_payment;
CREATE TRIGGER tr_hl_igp_gas_payment_delete
AFTER DELETE ON hl_igp_gas_payment
FOR EACH ROW EXECUTE FUNCTION hyperlane_shovel_on_gas_payment_delete();

DROP TRIGGER IF EXISTS tr_hl_merkle_insert_insert ON hl_merkle_insert;
CREATE TRIGGER tr_hl_merkle_insert_insert
AFTER INSERT ON hl_merkle_insert
FOR EACH ROW EXECUTE FUNCTION hyperlane_shovel_on_merkle_insert();

DROP TRIGGER IF EXISTS tr_hl_merkle_insert_delete ON hl_merkle_insert;
CREATE TRIGGER tr_hl_merkle_insert_delete
AFTER DELETE ON hl_merkle_insert
FOR EACH ROW EXECUTE FUNCTION hyperlane_shovel_on_merkle_delete();

-- =============================================================================
-- COMPATIBILITY VIEWS
-- =============================================================================

CREATE OR REPLACE VIEW shovel_total_gas_payment AS
SELECT
    msg_id,
    COUNT(msg_id) AS num_payments,
    SUM(payment) AS total_payment,
    SUM(gas_amount) AS total_gas_amount
FROM shovel_gas_payment
GROUP BY msg_id;

CREATE OR REPLACE VIEW shovel_message_view AS
SELECT
    msg.id,
    msg.msg_id,
    msg.nonce,
    dmsg.id IS NOT NULL AS is_delivered,
    COALESCE(tgp.num_payments, '0') AS num_payments,
    COALESCE(tgp.total_payment, '0') AS total_payment,
    COALESCE(tgp.total_gas_amount, '0') AS total_gas_amount,

    msg.origin AS origin_domain_id,
    origin_domain.chain_id AS origin_chain_id,
    origin_domain.name AS origin_domain,

    msg.destination AS destination_domain_id,
    dest_domain.chain_id AS destination_chain_id,
    dest_domain.name AS destination_domain,

    msg.time_created AS send_scraped_at,
    origin_block.timestamp AS send_occurred_at,
    dmsg.time_created AS delivery_scraped_at,
    dest_block.timestamp AS delivery_occurred_at,
    dest_block.timestamp - origin_block.timestamp AS delivery_latency,

    msg.sender,
    msg.recipient,
    msg.origin_mailbox,
    dmsg.destination_mailbox,

    msg.origin_tx_id,
    origin_tx.hash AS origin_tx_hash,
    origin_tx.gas_limit AS origin_tx_gas_limit,
    origin_tx.max_priority_fee_per_gas AS origin_tx_max_priority_fee_per_gas,
    origin_tx.max_fee_per_gas AS origin_tx_max_fee_per_gas,
    origin_tx.gas_price AS origin_tx_gas_price,
    origin_tx.effective_gas_price AS origin_tx_effective_gas_price,
    origin_tx.nonce AS origin_tx_nonce,
    origin_tx.sender AS origin_tx_sender,
    origin_tx.recipient AS origin_tx_recipient,
    origin_tx.gas_used AS origin_tx_gas_used,
    origin_tx.cumulative_gas_used AS origin_tx_cumulative_gas_used,

    origin_tx.block_id AS origin_block_id,
    origin_block.height AS origin_block_height,
    origin_block.hash AS origin_block_hash,

    dmsg.destination_tx_id,
    dest_tx.hash AS destination_tx_hash,
    dest_tx.gas_limit AS destination_tx_gas_limit,
    dest_tx.max_priority_fee_per_gas AS destination_tx_max_priority_fee_per_gas,
    dest_tx.max_fee_per_gas AS destination_tx_max_fee_per_gas,
    dest_tx.gas_price AS destination_tx_gas_price,
    dest_tx.effective_gas_price AS destination_tx_effective_gas_price,
    dest_tx.nonce AS destination_tx_nonce,
    dest_tx.sender AS destination_tx_sender,
    dest_tx.recipient AS destination_tx_recipient,
    dest_tx.gas_used AS destination_tx_gas_used,
    dest_tx.cumulative_gas_used AS destination_tx_cumulative_gas_used,

    dest_tx.block_id AS destination_block_id,
    dest_block.height AS destination_block_height,
    dest_block.hash AS destination_block_hash,

    msg.msg_body AS message_body
FROM shovel_message msg
LEFT JOIN domain origin_domain
       ON origin_domain.id = msg.origin
LEFT JOIN domain dest_domain
       ON dest_domain.id = msg.destination
LEFT JOIN shovel_transaction origin_tx
       ON origin_tx.id = msg.origin_tx_id
LEFT JOIN shovel_block origin_block
       ON origin_block.id = origin_tx.block_id
LEFT JOIN LATERAL (
    SELECT
        COUNT(*)::BIGINT AS num_payments,
        SUM(gp.payment) AS total_payment,
        SUM(gp.gas_amount) AS total_gas_amount
    FROM shovel_gas_payment gp
    WHERE gp.msg_id = msg.msg_id
) tgp ON TRUE
LEFT JOIN shovel_delivered_message dmsg
       ON dmsg.msg_id = msg.msg_id
LEFT JOIN shovel_transaction dest_tx
       ON dest_tx.id = dmsg.destination_tx_id
LEFT JOIN shovel_block dest_block
       ON dest_block.id = dest_tx.block_id;
