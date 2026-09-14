import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost/unused';

// Mainnet's slowest observed backfill minute on 2026-09-11: 151 requests,
// 155 DB queries, 61,550 rows, 843ms average DB time.
const OBSERVED_RPM = 151;
const OBSERVED_DB_MS = 843;
const OBSERVED_ROWS = 397;
const DB_POOL_SIZE = 10;
const DURATION_SECONDS = Number(process.env.LOAD_DURATION_SECONDS ?? 5);
const SCALES = [1, 3, 5, 10] as const;

assert(
  Number.isFinite(DURATION_SECONDS) && DURATION_SECONDS > 0,
  'LOAD_DURATION_SECONDS must be positive',
);

let dbInFlight = 0;
let maxDbInFlight = 0;
let maxDbWaiting = 0;
let dbSlots = DB_POOL_SIZE;
const dbWaiters: Array<() => void> = [];
const rows = Array.from({ length: OBSERVED_ROWS }, (_, index) => ({
  id: String(index),
  msg_id: `0x${'11'.repeat(32)}`,
  recipient: `0x${'22'.repeat(32)}`,
  send_occurred_at: '2026-07-24T12:00:00.000Z',
  sender: `0x${'33'.repeat(32)}`,
}));
const { createScraperProxyApp } = await import('../module.js');
const app = await createScraperProxyApp({
  async query<T extends Record<string, unknown>>(): Promise<T[]> {
    await acquireDb();
    dbInFlight++;
    maxDbInFlight = Math.max(maxDbInFlight, dbInFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, OBSERVED_DB_MS));
      // The benchmark exercises only message_view; the generic mirrors DbService.
      return rows as unknown as T[];
    } finally {
      dbInFlight--;
      dbSlots++;
      dbWaiters.shift()?.();
    }
  },
});
const operation = {
  method: 'POST' as const,
  payload: {
    query: `{
      message_view(
        where: {send_occurred_at: {_gte: "2026-07-24", _lt: "2026-07-25"}}
        order_by: {id: asc}
        limit: 500
      ) { id msg_id sender recipient send_occurred_at }
    }`,
  },
  url: '/graphql',
};

console.log(
  `Observed slow-minute model: ${OBSERVED_RPM} rpm, ${OBSERVED_DB_MS}ms DB, ${OBSERVED_ROWS} rows/response, ${DURATION_SECONDS}s/scenario`,
);
console.log(
  'load   requests success rejected p50ms p95ms maxDbInFlight maxDbWaiting',
);
try {
  for (const scale of SCALES) {
    maxDbInFlight = 0;
    maxDbWaiting = 0;
    const result = await runLoad(scale);
    console.log(
      `${`${scale}x`.padEnd(6)} ${String(result.requests).padEnd(8)} ${String(result.success).padEnd(7)} ${String(result.rejected).padEnd(8)} ${String(result.p50).padEnd(5)} ${String(result.p95).padEnd(5)} ${String(maxDbInFlight).padEnd(13)} ${maxDbWaiting}`,
    );
  }
} finally {
  await app.close();
}

async function runLoad(scale: number) {
  const requests = Math.max(
    1,
    Math.round((OBSERVED_RPM / 60) * scale * DURATION_SECONDS),
  );
  const intervalMs = (DURATION_SECONDS * 1_000) / requests;
  const latencies: number[] = [];
  let rejected = 0;
  let success = 0;
  await Promise.all(
    Array.from(
      { length: requests },
      (_, index) =>
        new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            const started = performance.now();
            void app.inject(operation).then((response) => {
              latencies.push(performance.now() - started);
              if (response.statusCode === 200) success++;
              else if (response.statusCode === 503) rejected++;
              else
                reject(new Error(`Unexpected status ${response.statusCode}`));
              resolve();
            }, reject);
          }, index * intervalMs);
        }),
    ),
  );
  latencies.sort((left, right) => left - right);
  return {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    rejected,
    requests,
    success,
  };
}

async function acquireDb(): Promise<void> {
  while (dbSlots === 0) {
    await new Promise<void>((resolve) => {
      dbWaiters.push(resolve);
      maxDbWaiting = Math.max(maxDbWaiting, dbWaiters.length);
    });
  }
  dbSlots--;
}

function percentile(values: number[], quantile: number): number {
  return Math.round(
    values[Math.max(0, Math.ceil(values.length * quantile) - 1)] ?? 0,
  );
}
