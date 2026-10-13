export const PROVISIONAL_MESSAGE_QUERY = `
  /* provisional_message_view */
  WITH frontier(domain, height) AS (
    SELECT * FROM unnest($2::integer[], $3::bigint[])
  ), dispatches AS (
    SELECT id, msg_id, nonce, origin_domain, destination_domain, time_created,
      sender, recipient, origin_mailbox, origin_tx_hash, origin_block_hash,
      origin_block_height, msg_body
    FROM raw_message_dispatch WHERE msg_id=ANY($1::bytea[])
    UNION ALL
    -- Historical/legacy messages can predate raw dispatch storage. Still
    -- project their delivery/payment updates through the selected frontiers.
    SELECT message.id, message.msg_id, message.nonce, message.origin,
      message.destination, message.time_created, message.sender,
      message.recipient, message.origin_mailbox, tx.hash, block.hash,
      block.height, message.msg_body
    FROM message
    JOIN "transaction" tx ON tx.id=message.origin_tx_id
    JOIN block ON block.id=tx.block_id
    WHERE message.msg_id=ANY($1::bytea[])
      AND NOT EXISTS (SELECT 1 FROM raw_message_dispatch raw
        WHERE raw.msg_id=message.msg_id)
  ), eligible_dispatch AS (
    SELECT dispatch.*
    FROM dispatches dispatch
    LEFT JOIN frontier ON frontier.domain=dispatch.origin_domain
    LEFT JOIN scraper_head ON scraper_head.domain=dispatch.origin_domain
    WHERE dispatch.msg_id=ANY($1::bytea[])
      AND dispatch.origin_block_height<=coalesce(frontier.height,
        scraper_head.confirmed_height, 9223372036854775807)
  ), eligible_delivery AS (
    SELECT DISTINCT ON (delivery.msg_id) delivery.*
    FROM delivered_message delivery
    LEFT JOIN frontier ON frontier.domain=delivery.domain
    LEFT JOIN scraper_head ON scraper_head.domain=delivery.domain
    WHERE delivery.msg_id=ANY($1::bytea[])
      AND (delivery.block_number IS NULL OR delivery.block_number<=coalesce(
        frontier.height, scraper_head.confirmed_height, 9223372036854775807))
    ORDER BY delivery.msg_id, delivery.block_number DESC NULLS LAST, delivery.id DESC
  ), eligible_payment AS (
    SELECT payment.msg_id, count(*)::bigint AS num_payments,
      sum(payment.payment) AS total_payment,
      sum(payment.gas_amount) AS total_gas_amount
    FROM gas_payment payment
    LEFT JOIN frontier ON frontier.domain=payment.domain
    LEFT JOIN scraper_head ON scraper_head.domain=payment.domain
    WHERE payment.msg_id=ANY($1::bytea[])
      AND (payment.block_number IS NULL OR payment.block_number<=coalesce(
        frontier.height, scraper_head.confirmed_height, 9223372036854775807))
    GROUP BY payment.msg_id
  )
  SELECT
    dispatch.id,
    dispatch.msg_id,
    dispatch.nonce,
    delivery.id IS NOT NULL AS is_delivered,
    coalesce(payment.num_payments, 0) AS num_payments,
    coalesce(payment.total_payment, 0) AS total_payment,
    coalesce(payment.total_gas_amount, 0) AS total_gas_amount,
    dispatch.origin_domain AS origin_domain_id,
    origin_domain.chain_id AS origin_chain_id,
    origin_domain.name AS origin_domain,
    dispatch.destination_domain AS destination_domain_id,
    destination_domain.chain_id AS destination_chain_id,
    destination_domain.name AS destination_domain,
    dispatch.time_created AS send_scraped_at,
    origin_block.timestamp AS send_occurred_at,
    delivery.time_created AS delivery_scraped_at,
    destination_block.timestamp AS delivery_occurred_at,
    destination_block.timestamp-origin_block.timestamp AS delivery_latency,
    dispatch.time_created-origin_block.timestamp AS send_scape_latency,
    delivery.time_created-destination_block.timestamp AS delivery_scape_latency,
    dispatch.sender,
    dispatch.recipient,
    dispatch.origin_mailbox,
    delivery.destination_mailbox,
    origin_tx.id AS origin_tx_id,
    coalesce(origin_tx.hash, dispatch.origin_tx_hash) AS origin_tx_hash,
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
    origin_block.id AS origin_block_id,
    dispatch.origin_block_height,
    dispatch.origin_block_hash,
    destination_tx.id AS destination_tx_id,
    coalesce(destination_tx.hash, delivery.transaction_hash) AS destination_tx_hash,
    destination_tx.gas_limit AS destination_tx_gas_limit,
    destination_tx.max_priority_fee_per_gas AS destination_tx_max_priority_fee_per_gas,
    destination_tx.max_fee_per_gas AS destination_tx_max_fee_per_gas,
    destination_tx.gas_price AS destination_tx_gas_price,
    destination_tx.effective_gas_price AS destination_tx_effective_gas_price,
    destination_tx.nonce AS destination_tx_nonce,
    destination_tx.sender AS destination_tx_sender,
    destination_tx.recipient AS destination_tx_recipient,
    destination_tx.gas_used AS destination_tx_gas_used,
    destination_tx.cumulative_gas_used AS destination_tx_cumulative_gas_used,
    destination_block.id AS destination_block_id,
    coalesce(delivery.block_number, destination_block.height) AS destination_block_height,
    coalesce(delivery.block_hash, destination_block.hash) AS destination_block_hash,
    dispatch.msg_body AS message_body
  FROM eligible_dispatch dispatch
  LEFT JOIN domain origin_domain ON origin_domain.id=dispatch.origin_domain
  LEFT JOIN domain destination_domain ON destination_domain.id=dispatch.destination_domain
  LEFT JOIN block origin_block ON origin_block.domain=dispatch.origin_domain
    AND origin_block.hash=dispatch.origin_block_hash
  LEFT JOIN "transaction" origin_tx ON origin_tx.block_id=origin_block.id
    AND origin_tx.hash=dispatch.origin_tx_hash
  LEFT JOIN eligible_delivery delivery ON delivery.msg_id=dispatch.msg_id
  LEFT JOIN "transaction" identified_destination_tx
    ON identified_destination_tx.id=delivery.destination_tx_id
  LEFT JOIN block destination_block ON destination_block.domain=delivery.domain
    AND (destination_block.hash=delivery.block_hash OR
      (delivery.block_hash IS NULL AND
        destination_block.id=identified_destination_tx.block_id))
  LEFT JOIN "transaction" destination_tx ON destination_tx.id=delivery.destination_tx_id
    OR (delivery.destination_tx_id IS NULL AND destination_tx.block_id=destination_block.id
      AND destination_tx.hash=delivery.transaction_hash)
  LEFT JOIN eligible_payment payment ON payment.msg_id=dispatch.msg_id
  WHERE origin_block.timestamp IS NOT NULL
`;
