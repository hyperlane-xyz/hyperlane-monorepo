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

void it(
  'selects the latest numeric snapshot update, resets anchors, and retains legacy reporters',
  { skip: !process.env.DIAGNOSTICS_TEST_DATABASE_URL },
  async () => {
    const client = new pg.Client({
      connectionString: process.env.DIAGNOSTICS_TEST_DATABASE_URL,
    });
    await client.connect();
    try {
      await client.query(`CREATE TEMP TABLE message_activity (
        id bigint PRIMARY KEY, message_id bytea, relayer bytea, origin bigint, destination bigint,
        observed_at timestamptz, received_at timestamptz, version integer, activity jsonb
      )`);
      const id = `0x${'01'.repeat(32)}`;
      async function insert(
        number: number,
        relayer: string,
        activity: Record<string, unknown>,
      ) {
        await client.query(
          `INSERT INTO message_activity VALUES ($1,decode($2,'hex'),decode($3,'hex'),1,2,now(),now(),1,$4)`,
          [number, id.slice(2), relayer, activity],
        );
      }
      const state = (phase: string) => ({
        phase,
        tree_root: null,
        modules: [],
      });
      await insert(8, '02', { type: 'snapshot', state: state('preparing') });
      await insert(9, '02', {
        type: 'snapshot_update',
        state: { ...state('awaiting_signatures'), removed_modules: [] },
      });
      await insert(10, '02', {
        type: 'snapshot_update',
        state: { ...state('delivered'), removed_modules: [] },
      });
      await insert(11, '03', { type: 'delivered' });
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
      const [initial] = await service.snapshots([id]);
      assert.deepEqual(
        initial?.activities.map((row) => row.id),
        ['8', '10', '11'],
      );
      assert.equal(initial?.relayers[0]?.phase, Phase.Delivered);
      assert.equal(initial?.relayers[1]?.phase, Phase.Delivered);
      await insert(12, '02', { type: 'snapshot', state: state('retrying') });
      await insert(13, '02', {
        type: 'snapshot_update',
        state: { ...state('ready_to_submit'), removed_modules: [] },
      });
      const [reset] = await service.snapshots([id]);
      assert.deepEqual(
        reset?.activities.map((row) => row.id),
        ['11', '12', '13'],
      );
      assert.equal(
        reset?.relayers.find((row) => row.relayer.endsWith('02'))?.phase,
        Phase.ReadyToSubmit,
      );
    } finally {
      await client.end();
    }
  },
);

void it(
  'reads a retained 10000-update history within the production statement timeout',
  { skip: !process.env.DIAGNOSTICS_TEST_DATABASE_URL },
  async () => {
    const client = new pg.Client({
      connectionString: process.env.DIAGNOSTICS_TEST_DATABASE_URL,
      statement_timeout: 4000,
    });
    await client.connect();
    try {
      await client.query(`CREATE TEMP TABLE message_activity (
        id bigint PRIMARY KEY, message_id bytea, relayer bytea, origin bigint, destination bigint,
        observed_at timestamptz, received_at timestamptz, version integer, activity jsonb
      )`);
      await client.query(
        'CREATE INDEX ON message_activity(message_id,id DESC)',
      );
      const id = `0x${'01'.repeat(32)}`;
      await client.query(
        `INSERT INTO message_activity
        SELECT n,decode($1,'hex'),decode('02','hex'),1,2,now(),now(),1,
          jsonb_build_object('type',CASE WHEN n=1 THEN 'snapshot' ELSE 'snapshot_update' END,
            'state',jsonb_build_object('phase','preparing','tree_root',NULL,'modules','[]'::jsonb,'removed_modules','[]'::jsonb))
        FROM generate_series(1,10001) AS n`,
        [id.slice(2)],
      );
      await client.query('ANALYZE message_activity');
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
      const [result] = await service.snapshots([id]);
      assert.deepEqual(
        result?.activities.map((row) => row.id),
        ['1', '10001'],
      );
      assert.equal(result?.partial, false);
    } finally {
      await client.end();
    }
  },
);

async function withDiagnosticTable(
  run: (
    client: pg.Client,
    service: DiagnosticsService,
    messageId: string,
  ) => Promise<void>,
) {
  const client = new pg.Client({
    connectionString: process.env.DIAGNOSTICS_TEST_DATABASE_URL,
  });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE message_activity (
      id bigint PRIMARY KEY, message_id bytea, relayer bytea, origin bigint, destination bigint,
      observed_at timestamptz, received_at timestamptz, version integer, activity jsonb
    )`);
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
    await run(client, service, `0x${'01'.repeat(32)}`);
  } finally {
    await client.end();
  }
}

void it(
  'keeps anchored reporters complete when legacy history fills the row budget',
  { skip: !process.env.DIAGNOSTICS_TEST_DATABASE_URL },
  async () => {
    await withDiagnosticTable(async (client, service, messageId) => {
      const module = { node_id: 'root', ism: 'root-ism', children: [] };
      await client.query(
        `INSERT INTO message_activity VALUES
        (1,decode($1,'hex'),decode('02','hex'),1,2,now(),now(),1,$2),
        (103,decode($1,'hex'),decode('02','hex'),1,2,now(),now(),1,$3)`,
        [
          messageId.slice(2),
          {
            type: 'snapshot',
            state: { phase: 'preparing', tree_root: 'root', modules: [module] },
          },
          {
            type: 'snapshot_update',
            state: {
              phase: 'ready_to_submit',
              tree_root: 'root',
              modules: [{ ...module, verified: 1 }],
              removed_modules: [],
            },
          },
        ],
      );
      await client.query(
        `INSERT INTO message_activity
        SELECT n,decode($1,'hex'),decode('03','hex'),1,2,now(),now(),1,
          '{"type":"status","status":"FirstPrepareAttempt"}'::jsonb
        FROM generate_series(2,102) AS n`,
        [messageId.slice(2)],
      );
      const [result] = await service.snapshots([messageId]);
      assert(result);
      assert.equal(result.partial, true);
      assert(result.activities.length <= 100);
      assert(result.activities.some((row) => row.id === '1'));
      assert(result.activities.some((row) => row.id === '103'));
      const anchored = result.relayers.find((row) =>
        row.relayer.endsWith('02'),
      );
      assert.equal(anchored?.phase, Phase.ReadyToSubmit);
      assert.equal(anchored?.modules[0]?.node_id, 'root');
      assert.equal(anchored?.modules[0]?.verified, 1);
    });
  },
);

void it(
  'projects newer legacy events after the latest snapshot state on writer rollback',
  { skip: !process.env.DIAGNOSTICS_TEST_DATABASE_URL },
  async () => {
    await withDiagnosticTable(async (client, service, messageId) => {
      const state = (phase: string) => ({
        phase,
        tree_root: null,
        modules: [],
      });
      async function insert(id: number, activity: Record<string, unknown>) {
        await client.query(
          `INSERT INTO message_activity VALUES
          ($1,decode($2,'hex'),decode('02','hex'),1,2,now(),now(),1,$3)`,
          [id, messageId.slice(2), activity],
        );
      }
      await insert(7, { type: 'delivered' }); // Superseded by the full anchor.
      await insert(8, { type: 'snapshot', state: state('preparing') });
      await insert(9, {
        type: 'snapshot_update',
        state: { ...state('awaiting_signatures'), removed_modules: [] },
      });
      await insert(10, { type: 'delivered' }); // A legacy writer resumes this reporter.
      const [delivered] = await service.snapshots([messageId]);
      assert.deepEqual(
        delivered?.activities.map((row) => row.id),
        ['8', '9', '10'],
      );
      assert.equal(delivered?.relayers[0]?.phase, Phase.Delivered);
      await insert(11, { type: 'snapshot', state: state('preparing') });
      await insert(12, { type: 'status', status: 'ReadyToSubmit' });
      const [ready] = await service.snapshots([messageId]);
      assert.deepEqual(
        ready?.activities.map((row) => row.id),
        ['11', '12'],
      );
      assert.equal(ready?.relayers[0]?.phase, Phase.ReadyToSubmit);
      await insert(13, {
        type: 'snapshot_update',
        state: { ...state('confirming'), removed_modules: [] },
      });
      await insert(14, { type: 'dropped' });
      const [dropped] = await service.snapshots([messageId]);
      assert.deepEqual(
        dropped?.activities.map((row) => row.id),
        ['11', '13', '14'],
      );
      assert.equal(dropped?.relayers[0]?.phase, Phase.Dropped);
    });
  },
);
