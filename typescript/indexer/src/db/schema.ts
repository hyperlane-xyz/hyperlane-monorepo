import { relations } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  customType,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

// Custom bytea type for PostgreSQL binary data
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Buffer) {
    return value;
  },
  fromDriver(value: unknown) {
    return value as Buffer;
  },
});

// =============================================================================
// Domain table (shared with scraper - read only)
// =============================================================================
export const domain = pgTable('domain', {
  id: integer('id').primaryKey(),
  timeCreated: timestamp('time_created').notNull().defaultNow(),
  timeUpdated: timestamp('time_updated').notNull(),
  name: bytea('name').notNull(),
  nativeToken: bytea('native_token').notNull(),
  chainId: bigint('chain_id', { mode: 'number' }),
  isTestNet: integer('is_test_net').notNull(),
  isDeprecated: integer('is_deprecated').notNull(),
});

// =============================================================================
// PONDER_BLOCK
// =============================================================================
export const ponderBlock = pgTable(
  'ponder_block',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    timeCreated: timestamp('time_created').notNull().defaultNow(),
    domain: integer('domain')
      .notNull()
      .references(() => domain.id),
    hash: bytea('hash').unique().notNull(),
    height: bigint('height', { mode: 'number' }).notNull(),
    timestamp: timestamp('timestamp').notNull(),
  },
  (table) => [
    unique('ponder_block_domain_height_unique').on(table.domain, table.height),
    index('ponder_block_timestamp_idx').on(table.timestamp),
    index('ponder_block_domain_height_idx').on(table.domain, table.height),
  ],
);

export const ponderBlockRelations = relations(ponderBlock, ({ many }) => ({
  transactions: many(ponderTransaction),
}));

// =============================================================================
// PONDER_TRANSACTION
// =============================================================================
export const ponderTransaction = pgTable(
  'ponder_transaction',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    timeCreated: timestamp('time_created').notNull().defaultNow(),
    hash: bytea('hash').unique().notNull(),
    blockId: bigint('block_id', { mode: 'number' })
      .notNull()
      .references(() => ponderBlock.id),
    transactionIndex: integer('transaction_index').notNull(), // Position in block (for LogMeta)
    gasLimit: numeric('gas_limit', { precision: 78, scale: 0 }).notNull(),
    maxPriorityFeePerGas: numeric('max_priority_fee_per_gas', {
      precision: 78,
      scale: 0,
    }),
    maxFeePerGas: numeric('max_fee_per_gas', { precision: 78, scale: 0 }),
    gasPrice: numeric('gas_price', { precision: 78, scale: 0 }),
    effectiveGasPrice: numeric('effective_gas_price', {
      precision: 78,
      scale: 0,
    }),
    nonce: bigint('nonce', { mode: 'number' }).notNull(),
    sender: bytea('sender').notNull(),
    recipient: bytea('recipient'),
    gasUsed: numeric('gas_used', { precision: 78, scale: 0 }).notNull(),
    cumulativeGasUsed: numeric('cumulative_gas_used', {
      precision: 78,
      scale: 0,
    }).notNull(),
    rawInputData: bytea('raw_input_data'),
  },
  (table) => [index('ponder_transaction_block_idx').on(table.blockId)],
);

export const ponderTransactionRelations = relations(
  ponderTransaction,
  ({ one, many }) => ({
    block: one(ponderBlock, {
      fields: [ponderTransaction.blockId],
      references: [ponderBlock.id],
    }),
    messages: many(ponderMessage),
    deliveredMessages: many(ponderDeliveredMessage),
    gasPayments: many(ponderGasPayment),
    logs: many(ponderTransactionLog),
  }),
);

// =============================================================================
// PONDER_MESSAGE
// =============================================================================
export const ponderMessage = pgTable(
  'ponder_message',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    timeCreated: timestamp('time_created').notNull().defaultNow(),
    msgId: bytea('msg_id').notNull(),
    version: smallint('version').notNull().default(3), // Hyperlane message version
    origin: integer('origin')
      .notNull()
      .references(() => domain.id),
    destination: integer('destination')
      .notNull()
      .references(() => domain.id),
    nonce: integer('nonce').notNull(),
    sender: bytea('sender').notNull(),
    recipient: bytea('recipient').notNull(),
    msgBody: bytea('msg_body'),
    originMailbox: bytea('origin_mailbox').notNull(),
    originTxId: bigint('origin_tx_id', { mode: 'number' })
      .notNull()
      .references(() => ponderTransaction.id),
    logIndex: integer('log_index').notNull(), // Log index in tx (for LogMeta)
  },
  (table) => [
    unique('ponder_message_origin_mailbox_nonce_unique').on(
      table.origin,
      table.originMailbox,
      table.nonce,
    ),
    index('ponder_message_destination_idx').on(table.destination),
    index('ponder_message_origin_tx_idx').on(table.originTxId),
  ],
);

export const ponderMessageRelations = relations(ponderMessage, ({ one }) => ({
  originTx: one(ponderTransaction, {
    fields: [ponderMessage.originTxId],
    references: [ponderTransaction.id],
  }),
}));

// =============================================================================
// PONDER_DELIVERED_MESSAGE
// =============================================================================
export const ponderDeliveredMessage = pgTable(
  'ponder_delivered_message',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    timeCreated: timestamp('time_created').notNull().defaultNow(),
    msgId: bytea('msg_id').unique().notNull(),
    domain: integer('domain')
      .notNull()
      .references(() => domain.id),
    destinationMailbox: bytea('destination_mailbox').notNull(),
    destinationTxId: bigint('destination_tx_id', { mode: 'number' })
      .notNull()
      .references(() => ponderTransaction.id),
    logIndex: integer('log_index').notNull(), // Log index in tx (for LogMeta)
    sequence: bigint('sequence', { mode: 'number' }),
  },
  (table) => [
    index('ponder_delivered_message_domain_mailbox_idx').on(
      table.domain,
      table.destinationMailbox,
    ),
    index('ponder_delivered_message_domain_mailbox_seq_idx').on(
      table.domain,
      table.destinationMailbox,
      table.sequence,
    ),
    index('ponder_delivered_message_tx_idx').on(table.destinationTxId),
  ],
);

export const ponderDeliveredMessageRelations = relations(
  ponderDeliveredMessage,
  ({ one }) => ({
    destinationTx: one(ponderTransaction, {
      fields: [ponderDeliveredMessage.destinationTxId],
      references: [ponderTransaction.id],
    }),
  }),
);

// =============================================================================
// PONDER_GAS_PAYMENT
// =============================================================================
export const ponderGasPayment = pgTable(
  'ponder_gas_payment',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    timeCreated: timestamp('time_created').notNull().defaultNow(),
    domain: integer('domain')
      .notNull()
      .references(() => domain.id),
    msgId: bytea('msg_id').notNull(),
    payment: numeric('payment', { precision: 78, scale: 0 }).notNull(),
    gasAmount: numeric('gas_amount', { precision: 78, scale: 0 }).notNull(),
    txId: bigint('tx_id', { mode: 'number' })
      .notNull()
      .references(() => ponderTransaction.id),
    logIndex: bigint('log_index', { mode: 'number' }).notNull(),
    origin: integer('origin')
      .notNull()
      .references(() => domain.id),
    destination: integer('destination')
      .notNull()
      .references(() => domain.id),
    interchainGasPaymaster: bytea('interchain_gas_paymaster').notNull(),
    sequence: bigint('sequence', { mode: 'number' }),
  },
  (table) => [
    unique('ponder_gas_payment_msg_tx_log_unique').on(
      table.msgId,
      table.txId,
      table.logIndex,
    ),
    index('ponder_gas_payment_domain_id_idx').on(table.domain, table.id),
    index('ponder_gas_payment_origin_id_idx').on(table.origin, table.id),
    index('ponder_gas_payment_origin_igp_seq_idx').on(
      table.origin,
      table.interchainGasPaymaster,
      table.sequence,
    ),
  ],
);

export const ponderGasPaymentRelations = relations(
  ponderGasPayment,
  ({ one }) => ({
    tx: one(ponderTransaction, {
      fields: [ponderGasPayment.txId],
      references: [ponderTransaction.id],
    }),
  }),
);

// =============================================================================
// PONDER_MERKLE_TREE_INSERTION (for validator checkpoint signing)
// =============================================================================
export const ponderMerkleTreeInsertion = pgTable(
  'ponder_merkle_tree_insertion',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    timeCreated: timestamp('time_created').notNull().defaultNow(),
    domain: integer('domain')
      .notNull()
      .references(() => domain.id),
    leafIndex: integer('leaf_index').notNull(), // Same as message nonce
    messageId: bytea('message_id').notNull(),
    merkleTreeHook: bytea('merkle_tree_hook').notNull(), // Contract address
    txId: bigint('tx_id', { mode: 'number' })
      .notNull()
      .references(() => ponderTransaction.id),
    logIndex: integer('log_index').notNull(), // Log index in tx (for LogMeta)
  },
  (table) => [
    unique('ponder_merkle_tree_insertion_domain_hook_leaf_unique').on(
      table.domain,
      table.merkleTreeHook,
      table.leafIndex,
    ),
    index('ponder_merkle_tree_insertion_domain_idx').on(
      table.domain,
      table.leafIndex,
    ),
    index('ponder_merkle_tree_insertion_hook_idx').on(
      table.merkleTreeHook,
      table.leafIndex,
    ),
  ],
);

export const ponderMerkleTreeInsertionRelations = relations(
  ponderMerkleTreeInsertion,
  ({ one }) => ({
    tx: one(ponderTransaction, {
      fields: [ponderMerkleTreeInsertion.txId],
      references: [ponderTransaction.id],
    }),
  }),
);

// =============================================================================
// PONDER_RAW_MESSAGE_DISPATCH
// =============================================================================
export const ponderRawMessageDispatch = pgTable(
  'ponder_raw_message_dispatch',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    timeCreated: timestamp('time_created').notNull().defaultNow(),
    timeUpdated: timestamp('time_updated').notNull().defaultNow(),
    msgId: bytea('msg_id').unique().notNull(),
    originTxHash: bytea('origin_tx_hash').notNull(),
    originBlockHash: bytea('origin_block_hash').notNull(),
    originBlockHeight: bigint('origin_block_height', {
      mode: 'number',
    }).notNull(),
    nonce: integer('nonce').notNull(),
    originDomain: integer('origin_domain').notNull(),
    destinationDomain: integer('destination_domain').notNull(),
    sender: bytea('sender').notNull(),
    recipient: bytea('recipient').notNull(),
    originMailbox: bytea('origin_mailbox').notNull(),
  },
  (table) => [
    index('ponder_raw_message_dispatch_origin_domain_idx').on(
      table.originDomain,
    ),
    index('ponder_raw_message_dispatch_destination_domain_idx').on(
      table.destinationDomain,
    ),
  ],
);

// =============================================================================
// PONDER_REORG_EVENT (NEW - FR-5)
// =============================================================================
export const ponderReorgEvent = pgTable(
  'ponder_reorg_event',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    domain: integer('domain')
      .notNull()
      .references(() => domain.id),
    detectedAt: timestamp('detected_at').notNull().defaultNow(),
    reorgedBlockHeight: bigint('reorged_block_height', {
      mode: 'number',
    }).notNull(),
    reorgedBlockHash: bytea('reorged_block_hash').notNull(),
    newBlockHash: bytea('new_block_hash').notNull(),
    // Array of affected message IDs (stored as BYTEA[])
    affectedMsgIds: bytea('affected_msg_ids').array(),
  },
  (table) => [
    index('ponder_reorg_event_domain_idx').on(table.domain),
    index('ponder_reorg_event_detected_at_idx').on(table.detectedAt),
    index('ponder_reorg_event_height_idx').on(table.reorgedBlockHeight),
  ],
);

// =============================================================================
// PONDER_TRANSACTION_LOG (NEW - FR-9)
// =============================================================================
export const ponderTransactionLog = pgTable(
  'ponder_transaction_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    txId: bigint('tx_id', { mode: 'number' })
      .notNull()
      .references(() => ponderTransaction.id),
    logIndex: integer('log_index').notNull(),
    address: bytea('address').notNull(),
    // Array of topics (stored as BYTEA[])
    topics: bytea('topics').array().notNull(),
    data: bytea('data'),
  },
  (table) => [
    unique('ponder_transaction_log_tx_log_unique').on(
      table.txId,
      table.logIndex,
    ),
    index('ponder_transaction_log_tx_idx').on(table.txId),
  ],
);

export const ponderTransactionLogRelations = relations(
  ponderTransactionLog,
  ({ one }) => ({
    tx: one(ponderTransaction, {
      fields: [ponderTransactionLog.txId],
      references: [ponderTransaction.id],
    }),
  }),
);

// =============================================================================
// Type exports for use in adapter
// =============================================================================
export type PonderBlock = typeof ponderBlock.$inferInsert;
export type PonderTransaction = typeof ponderTransaction.$inferInsert;
export type PonderMessage = typeof ponderMessage.$inferInsert;
export type PonderDeliveredMessage = typeof ponderDeliveredMessage.$inferInsert;
export type PonderGasPayment = typeof ponderGasPayment.$inferInsert;
export type PonderMerkleTreeInsertion =
  typeof ponderMerkleTreeInsertion.$inferInsert;
export type PonderRawMessageDispatch =
  typeof ponderRawMessageDispatch.$inferInsert;
export type PonderReorgEvent = typeof ponderReorgEvent.$inferInsert;
export type PonderTransactionLog = typeof ponderTransactionLog.$inferInsert;
