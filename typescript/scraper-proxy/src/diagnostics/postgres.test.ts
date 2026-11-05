import assert from 'node:assert/strict';
import { it } from 'node:test';

import pg from 'pg';

import { DiagnosticsService } from './service.js';
import { Phase } from './types.js';

void it(
  'orders snapshots and every history page numerically across an ID digit boundary',
  { skip: !process.env.DIAGNOSTICS_TEST_DATABASE_URL },
  async () => {
    const client = new pg.Client({
      connectionString: process.env.DIAGNOSTICS_TEST_DATABASE_URL,
    });
    await client.connect();
    try {
      // A session-local fixture leaves any existing diagnostics data untouched.
      await client.query(`CREATE TEMP TABLE message_activity (
        id bigint PRIMARY KEY, message_id bytea, relayer bytea,
        origin bigint, destination bigint, observed_at timestamptz,
        received_at timestamptz, version integer, activity jsonb
      )`);
      const id = `0x${'01'.repeat(32)}`;
      const first = 9_999_890;
      const last = 10_000_009;
      await client.query(
        `INSERT INTO message_activity
         SELECT id, decode($1, 'hex'), decode('02', 'hex'), 1, 2,
           now(), now(), 1,
           jsonb_build_object('type', CASE WHEN id = $3 THEN 'delivered' ELSE 'dropped' END)
         FROM generate_series($2::bigint, $3::bigint) AS id`,
        [id.slice(2), first, last],
      );
      const service = new DiagnosticsService({
        query: async (sql, values) =>
          // Exercise the production queries against the isolated temporary table.
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
      const expected = Array.from({ length: last - first + 1 }, (_, i) =>
        String(last - i),
      );
      const history: string[] = [];
      let before: string | null | undefined;
      for (;;) {
        const page = await service.history(id, before, 7);
        assert.deepEqual(
          page.activities.map((activity) => activity.id),
          expected.slice(history.length, history.length + 7),
        );
        history.push(...page.activities.map((activity) => activity.id));
        assert.equal(page.has_more, history.length < expected.length);
        if (!page.has_more) {
          assert.equal(page.next_before_id, null);
          break;
        }
        assert.equal(page.next_before_id, history.at(-1));
        before = page.next_before_id;
      }
      assert.deepEqual(history, expected);
      const [snapshot] = await service.snapshots([id]);
      assert(snapshot);
      assert.equal(snapshot.partial, true);
      assert.deepEqual(
        snapshot.activities.map((activity) => activity.id),
        expected.slice(0, 100).reverse(),
      );
      assert.equal(snapshot.relayers[0]?.phase, Phase.Delivered);
    } finally {
      await client.end();
    }
  },
);
