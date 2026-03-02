#!/usr/bin/env tsx
/**
 * Run database migrations for ponder_* tables.
 *
 * Usage:
 *   pnpm db:migrate
 *   DATABASE_URL=... tsx scripts/migrate.ts
 */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL environment variable required');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString });

  try {
    // Read migration file
    const migrationPath = path.join(
      __dirname,
      '..',
      'migrations',
      '0001_ponder_tables.sql',
    );
    const migration = fs.readFileSync(migrationPath, 'utf-8');

    console.log('Running migration: 0001_ponder_tables.sql');

    // Execute migration
    await pool.query(migration);

    console.log('Migration completed successfully');

    // Verify tables were created
    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'ponder_%'
      ORDER BY table_name
    `);

    console.log('\nCreated tables:');
    for (const row of tables.rows) {
      console.log(`  - ${row.table_name}`);
    }
  } catch (error: unknown) {
    const err = error as Error;
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
