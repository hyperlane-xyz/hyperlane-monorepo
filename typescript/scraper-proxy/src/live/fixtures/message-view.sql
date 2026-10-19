-- Canonical message_view from m20230309_000005 + near_head migrations.
-- Keep independent of the provisional projection under test.
CREATE TEMP VIEW "message_view" AS
SELECT
    "msg"."id" AS "id",
    "msg"."msg_id" AS "msg_id",
    "msg"."nonce" AS "nonce",

    "dmsg"."id" IS NOT NULL AS "is_delivered",

    COALESCE("tgp"."num_payments", '0') AS "num_payments",
    COALESCE("tgp"."total_payment", '0') AS "total_payment",
    COALESCE("tgp"."total_gas_amount", '0') AS "total_gas_amount",

    "msg"."origin" AS "origin_domain_id",
    "origin_domain"."chain_id" AS "origin_chain_id",
    "origin_domain"."name" AS "origin_domain",

    "msg"."destination" AS "destination_domain_id",
    "dest_domain"."chain_id" AS "destination_chain_id",
    "dest_domain"."name" AS "destination_domain",

    "msg"."time_created" AS "send_scraped_at",
    "origin_block"."timestamp" AS "send_occurred_at",
    "dmsg"."time_created" AS "delivery_scraped_at",
    "dest_block"."timestamp" AS "delivery_occurred_at",
    "dest_block"."timestamp" - "origin_block"."timestamp" AS "delivery_latency",
    "msg"."time_created" - "origin_block"."timestamp" AS "send_scape_latency",
    "dmsg"."time_created" - "dest_block"."timestamp" AS "delivery_scape_latency",

    "msg"."sender" AS "sender",
    "msg"."recipient" AS "recipient",
    "msg"."origin_mailbox" AS "origin_mailbox",
    "dmsg"."destination_mailbox" AS "destination_mailbox",

    "msg"."origin_tx_id" AS "origin_tx_id",
    "origin_tx"."hash" AS "origin_tx_hash",
    "origin_tx"."gas_limit" AS "origin_tx_gas_limit",
    "origin_tx"."max_priority_fee_per_gas" AS "origin_tx_max_priority_fee_per_gas",
    "origin_tx"."max_fee_per_gas" AS "origin_tx_max_fee_per_gas",
    "origin_tx"."gas_price" AS "origin_tx_gas_price",
    "origin_tx"."effective_gas_price" AS "origin_tx_effective_gas_price",
    "origin_tx"."nonce" AS "origin_tx_nonce",
    "origin_tx"."sender" AS "origin_tx_sender",
    "origin_tx"."recipient" AS "origin_tx_recipient",
    "origin_tx"."gas_used" AS "origin_tx_gas_used",
    "origin_tx"."cumulative_gas_used" AS "origin_tx_cumulative_gas_used",

    "origin_tx"."block_id" AS "origin_block_id",
    "origin_block"."height" AS "origin_block_height",
    "origin_block"."hash" AS "origin_block_hash",

    "dmsg"."destination_tx_id" AS "destination_tx_id",
    "dest_tx"."hash" AS "destination_tx_hash",
    "dest_tx"."gas_limit" AS "destination_tx_gas_limit",
    "dest_tx"."max_priority_fee_per_gas" AS "destination_tx_max_priority_fee_per_gas",
    "dest_tx"."max_fee_per_gas" AS "destination_tx_max_fee_per_gas",
    "dest_tx"."gas_price" AS "destination_tx_gas_price",
    "dest_tx"."effective_gas_price" AS "destination_tx_effective_gas_price",
    "dest_tx"."nonce" AS "destination_tx_nonce",
    "dest_tx"."sender" AS "destination_tx_sender",
    "dest_tx"."recipient" AS "destination_tx_recipient",
    "dest_tx"."gas_used" AS "destination_tx_gas_used",
    "dest_tx"."cumulative_gas_used" AS "destination_tx_cumulative_gas_used",

    "dest_tx"."block_id" AS "destination_block_id",
    "dest_block"."height" AS "destination_block_height",
    "dest_block"."hash" AS "destination_block_hash",

    "msg"."msg_body" AS "message_body"
FROM "message" AS "msg"
    LEFT JOIN "domain"
        AS "origin_domain"
        ON "origin_domain"."id" = "msg"."origin"
    LEFT JOIN "domain"
        AS "dest_domain"
        ON "dest_domain"."id" = "msg"."destination"
    LEFT JOIN "transaction"
        AS "origin_tx"
        ON "origin_tx"."id" = "msg"."origin_tx_id"
    LEFT JOIN "block"
        AS "origin_block"
        ON "origin_block"."id" = "origin_tx"."block_id"
    LEFT JOIN LATERAL
    (
        SELECT
            COUNT(*)::bigint AS num_payments,
            SUM(gp.payment) AS total_payment,
            SUM(gp.gas_amount) AS total_gas_amount
        FROM confirmed_gas_payment gp
        WHERE "gp"."msg_id" = "msg"."msg_id"
    ) tgp ON true
    LEFT JOIN "confirmed_delivered_message"
        AS "dmsg"
        ON "dmsg"."msg_id" = "msg"."msg_id"
    LEFT JOIN "transaction"
        AS "dest_tx"
        ON "dest_tx"."id" = "dmsg"."destination_tx_id"
    LEFT JOIN "block"
        AS "dest_block"
        ON "dest_block"."id" = "dest_tx"."block_id";
