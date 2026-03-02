/**
 * Minimal Ponder schema - required by framework but we use custom PostgreSQL tables.
 *
 * Ponder requires a schema file, but we write to custom ponder_* tables via Drizzle
 * to maintain compatibility with the existing scraper schema for comparison.
 *
 * This file defines minimal tracking tables that Ponder uses internally.
 */
import { index, onchainTable } from 'ponder';

// Tracking table for indexed events - used for debugging/monitoring
export const indexedEvent = onchainTable(
  'ponder_indexed_event',
  (t) => ({
    id: t.text().primaryKey(),
    chainId: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
    eventType: t.text().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    chainBlockIdx: index().on(table.chainId, table.blockNumber),
    eventTypeIdx: index().on(table.eventType),
  }),
);
