-- Ponder indexer tables
-- These mirror the existing scraper schema with ponder_ prefix for comparison
-- Once validated, can switch to write directly to scraper tables

-- =============================================================================
-- PONDER_BLOCK - Mirrors scraper block table
-- =============================================================================
CREATE TABLE IF NOT EXISTS ponder_block (
    id BIGSERIAL PRIMARY KEY,
    time_created TIMESTAMP NOT NULL DEFAULT NOW(),
    domain INTEGER NOT NULL REFERENCES domain(id),
    hash BYTEA UNIQUE NOT NULL,
    height BIGINT NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    UNIQUE (domain, height)
);

CREATE INDEX IF NOT EXISTS ponder_block_hash_idx ON ponder_block USING HASH (hash);
CREATE INDEX IF NOT EXISTS ponder_block_timestamp_idx ON ponder_block (timestamp);
CREATE INDEX IF NOT EXISTS ponder_block_domain_height_idx ON ponder_block (domain, height);

-- =============================================================================
-- PONDER_TRANSACTION - Mirrors scraper transaction table
-- =============================================================================
CREATE TABLE IF NOT EXISTS ponder_transaction (
    id BIGSERIAL PRIMARY KEY,
    time_created TIMESTAMP NOT NULL DEFAULT NOW(),
    hash BYTEA UNIQUE NOT NULL,
    block_id BIGINT NOT NULL REFERENCES ponder_block(id),
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

CREATE INDEX IF NOT EXISTS ponder_transaction_hash_idx ON ponder_transaction USING HASH (hash);
CREATE INDEX IF NOT EXISTS ponder_transaction_sender_idx ON ponder_transaction USING HASH (sender);
CREATE INDEX IF NOT EXISTS ponder_transaction_block_idx ON ponder_transaction (block_id);

-- =============================================================================
-- PONDER_MESSAGE - Mirrors scraper message table
-- =============================================================================
CREATE TABLE IF NOT EXISTS ponder_message (
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
    origin_tx_id BIGINT NOT NULL REFERENCES ponder_transaction(id),
    UNIQUE (origin, origin_mailbox, nonce)
);

CREATE INDEX IF NOT EXISTS ponder_message_sender_idx ON ponder_message USING HASH (sender);
CREATE INDEX IF NOT EXISTS ponder_message_recipient_idx ON ponder_message USING HASH (recipient);
CREATE INDEX IF NOT EXISTS ponder_message_msg_id_idx ON ponder_message USING HASH (msg_id);
CREATE INDEX IF NOT EXISTS ponder_message_destination_idx ON ponder_message (destination);
CREATE INDEX IF NOT EXISTS ponder_message_origin_tx_idx ON ponder_message (origin_tx_id);

-- =============================================================================
-- PONDER_DELIVERED_MESSAGE - Mirrors scraper delivered_message table
-- =============================================================================
CREATE TABLE IF NOT EXISTS ponder_delivered_message (
    id BIGSERIAL PRIMARY KEY,
    time_created TIMESTAMP NOT NULL DEFAULT NOW(),
    msg_id BYTEA UNIQUE NOT NULL,
    domain INTEGER NOT NULL REFERENCES domain(id),
    destination_mailbox BYTEA NOT NULL,
    destination_tx_id BIGINT NOT NULL REFERENCES ponder_transaction(id),
    sequence BIGINT
);

CREATE INDEX IF NOT EXISTS ponder_delivered_message_domain_mailbox_idx
    ON ponder_delivered_message (domain, destination_mailbox);
CREATE INDEX IF NOT EXISTS ponder_delivered_message_domain_mailbox_seq_idx
    ON ponder_delivered_message (domain, destination_mailbox, sequence);
CREATE INDEX IF NOT EXISTS ponder_delivered_message_tx_idx ON ponder_delivered_message (destination_tx_id);
CREATE INDEX IF NOT EXISTS ponder_delivered_message_msg_id_idx ON ponder_delivered_message USING HASH (msg_id);

-- =============================================================================
-- PONDER_GAS_PAYMENT - Mirrors scraper gas_payment table
-- =============================================================================
CREATE TABLE IF NOT EXISTS ponder_gas_payment (
    id BIGSERIAL PRIMARY KEY,
    time_created TIMESTAMP NOT NULL DEFAULT NOW(),
    domain INTEGER NOT NULL REFERENCES domain(id),
    msg_id BYTEA NOT NULL,
    payment NUMERIC(78, 0) NOT NULL,
    gas_amount NUMERIC(78, 0) NOT NULL,
    tx_id BIGINT NOT NULL REFERENCES ponder_transaction(id),
    log_index BIGINT NOT NULL,
    origin INTEGER NOT NULL REFERENCES domain(id),
    destination INTEGER NOT NULL REFERENCES domain(id),
    interchain_gas_paymaster BYTEA NOT NULL,
    sequence BIGINT,
    UNIQUE (msg_id, tx_id, log_index)
);

CREATE INDEX IF NOT EXISTS ponder_gas_payment_msg_id_idx ON ponder_gas_payment USING HASH (msg_id);
CREATE INDEX IF NOT EXISTS ponder_gas_payment_domain_id_idx ON ponder_gas_payment (domain, id);
CREATE INDEX IF NOT EXISTS ponder_gas_payment_origin_id_idx ON ponder_gas_payment (origin, id);
CREATE INDEX IF NOT EXISTS ponder_gas_payment_origin_igp_seq_idx
    ON ponder_gas_payment (origin, interchain_gas_paymaster, sequence);

-- =============================================================================
-- PONDER_RAW_MESSAGE_DISPATCH - Mirrors scraper raw_message_dispatch table
-- =============================================================================
CREATE TABLE IF NOT EXISTS ponder_raw_message_dispatch (
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

CREATE INDEX IF NOT EXISTS ponder_raw_message_dispatch_origin_domain_idx
    ON ponder_raw_message_dispatch (origin_domain);
CREATE INDEX IF NOT EXISTS ponder_raw_message_dispatch_destination_domain_idx
    ON ponder_raw_message_dispatch (destination_domain);
CREATE INDEX IF NOT EXISTS ponder_raw_message_dispatch_origin_tx_hash_idx
    ON ponder_raw_message_dispatch USING HASH (origin_tx_hash);

-- =============================================================================
-- PONDER_REORG_EVENT - NEW: Track reorg history (FR-5)
-- =============================================================================
CREATE TABLE IF NOT EXISTS ponder_reorg_event (
    id BIGSERIAL PRIMARY KEY,
    domain INTEGER NOT NULL REFERENCES domain(id),
    detected_at TIMESTAMP NOT NULL DEFAULT NOW(),
    reorged_block_height BIGINT NOT NULL,
    reorged_block_hash BYTEA NOT NULL,
    new_block_hash BYTEA NOT NULL,
    affected_msg_ids BYTEA[]
);

CREATE INDEX IF NOT EXISTS ponder_reorg_event_domain_idx ON ponder_reorg_event (domain);
CREATE INDEX IF NOT EXISTS ponder_reorg_event_detected_at_idx ON ponder_reorg_event (detected_at);
CREATE INDEX IF NOT EXISTS ponder_reorg_event_height_idx ON ponder_reorg_event (reorged_block_height);

-- =============================================================================
-- PONDER_TRANSACTION_LOG - NEW: Full transaction log indexing (FR-9)
-- =============================================================================
CREATE TABLE IF NOT EXISTS ponder_transaction_log (
    id BIGSERIAL PRIMARY KEY,
    tx_id BIGINT NOT NULL REFERENCES ponder_transaction(id),
    log_index INTEGER NOT NULL,
    address BYTEA NOT NULL,
    topics BYTEA[] NOT NULL,
    data BYTEA,
    UNIQUE (tx_id, log_index)
);

CREATE INDEX IF NOT EXISTS ponder_transaction_log_tx_idx ON ponder_transaction_log (tx_id);
CREATE INDEX IF NOT EXISTS ponder_transaction_log_address_idx ON ponder_transaction_log USING HASH (address);

-- =============================================================================
-- VIEWS
-- =============================================================================

-- Total gas payment aggregation view
CREATE OR REPLACE VIEW ponder_total_gas_payment AS
SELECT
    msg_id,
    COUNT(*) as num_payments,
    SUM(payment) as total_payment,
    SUM(gas_amount) as total_gas_amount
FROM ponder_gas_payment
GROUP BY msg_id;

-- Message view with delivery status and latency
CREATE OR REPLACE VIEW ponder_message_view AS
SELECT
    m.id,
    m.time_created,
    m.msg_id,
    m.origin,
    m.destination,
    m.nonce,
    m.sender,
    m.recipient,
    m.msg_body,
    m.origin_mailbox,
    -- Origin transaction/block info
    ot.hash as origin_tx_hash,
    ot.gas_used as origin_gas_used,
    ob.height as origin_block_height,
    ob.hash as origin_block_hash,
    ob.timestamp as origin_block_timestamp,
    -- Delivery info
    dm.id IS NOT NULL as is_delivered,
    dm.destination_mailbox,
    dm.sequence as delivery_sequence,
    -- Destination transaction/block info
    dt.hash as destination_tx_hash,
    dt.gas_used as destination_gas_used,
    db.height as destination_block_height,
    db.hash as destination_block_hash,
    db.timestamp as destination_block_timestamp,
    -- Latency (seconds between origin and destination blocks)
    EXTRACT(EPOCH FROM (db.timestamp - ob.timestamp)) as delivery_latency_seconds,
    -- Gas payment info
    gp.total_payment,
    gp.total_gas_amount,
    gp.num_payments
FROM ponder_message m
JOIN ponder_transaction ot ON m.origin_tx_id = ot.id
JOIN ponder_block ob ON ot.block_id = ob.id
LEFT JOIN ponder_delivered_message dm ON m.msg_id = dm.msg_id
LEFT JOIN ponder_transaction dt ON dm.destination_tx_id = dt.id
LEFT JOIN ponder_block db ON dt.block_id = db.id
LEFT JOIN ponder_total_gas_payment gp ON m.msg_id = gp.msg_id;
