#!/usr/bin/env tsx
/**
 * Run shovel pipeline migration (database-native pipeline).
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm shovel:db:migrate
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
    const migrationPath = path.join(
      __dirname,
      '..',
      'migrations',
      '0002_shovel_pipeline.sql',
    );
    const migration = fs.readFileSync(migrationPath, 'utf-8');

    console.log('Running migration: 0002_shovel_pipeline.sql');
    await pool.query(migration);
    console.log('Migration completed successfully');

    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (
          table_name LIKE 'hl_%'
          OR table_name LIKE 'shovel_%'
        )
      ORDER BY table_name
    `);

    console.log('\nAvailable shovel tables:');
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
