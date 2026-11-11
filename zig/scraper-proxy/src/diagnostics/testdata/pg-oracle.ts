// Prints the TS DiagnosticsService bytes for the row inserted by
// postgres_test.zig "converts real rows like node-pg" (the expected literals
// there come from this script). Run from the repository root with
// DIAGNOSTICS_TEST_DATABASE_URL set:
//   pnpm -C zig/scraper-proxy exec tsx src/diagnostics/testdata/pg-oracle.ts
import pg from 'pg';

import { DiagnosticsService } from '../../../../../typescript/scraper-proxy/src/diagnostics/service.js';

export const insertSql = `INSERT INTO message_activity VALUES (5, decode($1,'hex'), decode('02','hex'),
  9007199254740993, 2, '2026-11-05 00:00:00.123456+00', '2026-11-05 00:00:01+00', 1, $2::jsonb)`;
export const activity =
  '{"b": 1, "10": [1.0, "x", 1e21, -0.0, 0.1], "a": {"2": true, "1": null}, "type": "status", "status": "ReadyToSubmit", "__proto__": {"x": 1}}';

async function main() {
  const client = new pg.Client({
    connectionString: process.env.DIAGNOSTICS_TEST_DATABASE_URL,
  });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE message_activity (id bigint PRIMARY KEY, message_id bytea,
      relayer bytea, origin bigint, destination bigint, observed_at timestamptz,
      received_at timestamptz, version integer, activity jsonb)`);
    await client.query(insertSql, ['01'.repeat(32), activity]);
    const service = new DiagnosticsService({
      query: async (sql, values) =>
        (
          await client.query<Record<string, unknown>>(
            sql.replaceAll(
              'public.message_activity',
              'pg_temp.message_activity',
            ),
            values,
          )
        ).rows,
    });
    const id = `0x${'01'.repeat(32)}`;
    process.stdout.write(
      `${JSON.stringify(await service.history(id, null, 1))}\n`,
    );
    process.stdout.write(`${JSON.stringify(await service.snapshots([id]))}\n`);
  } finally {
    await client.end();
  }
}

await main();
