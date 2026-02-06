#!/usr/bin/env tsx
/**
 * Drop all ponder_* tables to reset the database.
 *
 * Usage:
 *   DATABASE_URL=... pnpm tsx scripts/drop-ponder-tables.ts
 */
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL environment variable required');
  process.exit(1);
}

async function main() {
  const pool = new Pool({ connectionString });

  try {
    console.log('Dropping ponder_* tables and views...');

    // Drop views first
    await pool.query(`
      DROP VIEW IF EXISTS ponder_message_view CASCADE;
      DROP VIEW IF EXISTS ponder_total_gas_payment CASCADE;
    `);
    console.log('  ✓ Dropped views');

    // Drop tables in reverse dependency order
    await pool.query(`
      DROP TABLE IF EXISTS ponder_transaction_log CASCADE;
      DROP TABLE IF EXISTS ponder_reorg_event CASCADE;
      DROP TABLE IF EXISTS ponder_merkle_tree_insertion CASCADE;
      DROP TABLE IF EXISTS ponder_gas_payment CASCADE;
      DROP TABLE IF EXISTS ponder_delivered_message CASCADE;
      DROP TABLE IF EXISTS ponder_message CASCADE;
      DROP TABLE IF EXISTS ponder_raw_message_dispatch CASCADE;
      DROP TABLE IF EXISTS ponder_transaction CASCADE;
      DROP TABLE IF EXISTS ponder_block CASCADE;
    `);
    console.log('  ✓ Dropped tables');

    // Also drop Ponder's internal tables if they exist
    await pool.query(`
      DROP TABLE IF EXISTS _ponder_meta CASCADE;
      DROP TABLE IF EXISTS _ponder_reorg CASCADE;
    `);
    console.log('  ✓ Dropped Ponder internal tables');

    console.log('\nAll ponder tables dropped successfully');
  } catch (error) {
    console.error('Failed to drop tables:', (error as Error).message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
