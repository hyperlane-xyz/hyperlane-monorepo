#!/usr/bin/env node
import { createSqlAdapter } from './sql/factory.js';

type RunRow = {
  id: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  error: string | null;
};

type CountRow = { count: number };

type RunLogRow = {
  stage: string;
  message: string;
  created_at: number;
};

async function main(): Promise<void> {
  const dbUrl = process.env.LLM_REBALANCER_DB_URL;
  const limit = Number(process.env.LLM_REBALANCER_INSPECT_LIMIT ?? '10');

  if (!dbUrl) {
    throw new Error('LLM_REBALANCER_DB_URL is required');
  }

  const sql = await createSqlAdapter(dbUrl);
  try {
    const runs = await sql.query<RunRow>(
      `SELECT id, started_at, ended_at, status, error
       FROM runs
       ORDER BY started_at DESC
       LIMIT $1`,
      [limit],
    );

    const [openActions, openIntents, inflight] = await Promise.all([
      sql.query<CountRow>(
        `SELECT COUNT(*) as count FROM actions WHERE status IN ('open','in_progress','submitted')`,
      ),
      sql.query<CountRow>(
        `SELECT COUNT(*) as count FROM intents WHERE status IN ('open','in_progress')`,
      ),
      sql.query<CountRow>(`SELECT COUNT(*) as count FROM inflight_messages`),
    ]);

    // eslint-disable-next-line no-console
    console.log('Recent runs:');
    for (const run of runs) {
      // eslint-disable-next-line no-console
      console.log(
        `${run.id} | ${run.status} | start=${new Date(run.started_at).toISOString()} | end=${
          run.ended_at ? new Date(run.ended_at).toISOString() : 'n/a'
        }${run.error ? ` | error=${run.error}` : ''}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(
      `Open state: actions=${openActions[0]?.count ?? 0}, intents=${
        openIntents[0]?.count ?? 0
      }, inflight=${inflight[0]?.count ?? 0}`,
    );

    const latestFailed = runs.find((r) => r.status === 'failed');
    if (!latestFailed) return;

    const runlog = await sql.query<RunLogRow>(
      `SELECT stage, message, created_at
       FROM runlog
       WHERE run_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [latestFailed.id],
    );

    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(`Latest failed run: ${latestFailed.id}`);
    for (const row of runlog.reverse()) {
      // eslint-disable-next-line no-console
      console.log(
        `${new Date(row.created_at).toISOString()} [${row.stage}] ${row.message}`,
      );
    }
  } finally {
    await sql.close();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
