import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { formatError } from '@hyperlane-xyz/utils/errors';
import pg from 'pg';

import { config } from '../config.js';
import {
  databaseQueries,
  DatabaseQueryRole,
  databaseQueryDuration,
  databaseRows,
  type DatabaseMetricsSnapshot,
} from '../metrics.js';
import { quoteIdentifier } from '../scraperdb/tables.js';

const MIN_POOL_CLIENTS = 5;
const MAX_POOL_CLIENTS = 10;
const STATS_INTERVAL_MS = 60_000;
const IDLE_TIMEOUT_MS = 300_000;
const EVENT_STREAM_SCHEMA_QUERY = `
  SELECT
    to_regclass('gas_payment_stream_head') IS NOT NULL AS head_exists,
    to_regclass('gas_payment_stream_cursor') IS NOT NULL AS cursor_exists,
    to_regclass('gas_payment_stream_cursor_range_key') IS NOT NULL AS range_index_exists,
    EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = to_regclass('gas_payment_stream_head')
        AND attname = 'legacy_max_id'
        AND NOT attisdropped
    ) AS legacy_boundary_exists,
    EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = to_regclass('gas_payment')
        AND tgname = 'gas_payment_stream_cursor_assign'
        AND NOT tgisinternal
    ) AS cursor_trigger_exists,
    COALESCE(
      has_table_privilege(
        current_user,
        to_regclass('gas_payment_stream_head'),
        'SELECT'
      ),
      false
    ) AS head_readable,
    COALESCE(
      has_table_privilege(
        current_user,
        to_regclass('gas_payment_stream_cursor'),
        'SELECT'
      ),
      false
    ) AS cursor_readable
`;

[1114, 1186].forEach((oid) =>
  pg.types.setTypeParser(oid, (value: string) => value),
);
pg.types.setTypeParser(17, (value: string) => value);

type Stats = {
  errors: number;
  maxMs: number;
  queries: number;
  rows: number;
  totalMs: number;
};

type EventStreamSchema = {
  cursor_exists: boolean;
  cursor_readable: boolean;
  cursor_trigger_exists: boolean;
  head_exists: boolean;
  head_readable: boolean;
  legacy_boundary_exists: boolean;
  range_index_exists: boolean;
};
const EVENT_STREAM_SCHEMA_CHECKS: readonly (keyof EventStreamSchema)[] = [
  'cursor_exists',
  'cursor_readable',
  'cursor_trigger_exists',
  'head_exists',
  'head_readable',
  'legacy_boundary_exists',
  'range_index_exists',
];

@Injectable()
export class DbService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(DbService.name);
  private readonly listeners = new Set<pg.Client>();
  private mainPool?: pg.Pool;
  private nextQueryId = 0;
  private livePool?: pg.Pool;
  private stats = newStats();
  private statsTimer?: NodeJS.Timeout;

  async onModuleInit(): Promise<void> {
    if (config.DATABASE_READ_REPLICA_URL) {
      this.logger.log(
        'GraphQL db role=read-replica; connections open lazily so replica health cannot gate websocket startup',
      );
      this.statsTimer = setInterval(() => this.logStats(), STATS_INTERVAL_MS);
      return;
    }
    const started = Date.now();
    const clients = await Promise.all(
      Array.from({ length: MIN_POOL_CLIENTS }, () => this.pool().connect()),
    );
    clients.forEach((client) => client.release());
    await this.validateEventStreamSchema();
    this.logger.log(
      `warmed ${MIN_POOL_CLIENTS} GraphQL db connections role=primary in ${Date.now() - started}ms`,
    );
    this.statsTimer = setInterval(() => this.logStats(), STATS_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.statsTimer) clearInterval(this.statsTimer);
    const { livePool, mainPool } = this;
    const shutdowns = [
      ...[...this.listeners].map((client) => () => client.end()),
      ...(livePool ? [() => livePool.end()] : []),
      ...(mainPool ? [() => mainPool.end()] : []),
    ];
    this.listeners.clear();
    const results = await Promise.allSettled(
      shutdowns.map((shutdown) => Promise.resolve().then(shutdown)),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    failures.forEach((error) =>
      this.logger.error(`database shutdown failed: ${formatError(error)}`),
    );
    if (failures.length) throw failures[0];
  }

  metricsSnapshot(): DatabaseMetricsSnapshot {
    return {
      listeners: this.listeners.size,
      pools: {
        live: poolMetrics(this.livePool),
        main: poolMetrics(this.mainPool),
      },
    };
  }

  query<T extends pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return this.run(
      this.pool(),
      config.DATABASE_READ_REPLICA_URL
        ? DatabaseQueryRole.GraphqlReplica
        : DatabaseQueryRole.GraphqlPrimary,
      text,
      values,
    );
  }

  queryLive<T extends pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return this.run(this.live(), DatabaseQueryRole.LivePrimary, text, values);
  }

  async listen(
    channels: readonly string[],
    handler: (channel: string, payload: string | undefined) => void,
    onDisconnect: (error?: Error) => void,
  ): Promise<() => Promise<void>> {
    const client = new pg.Client(databaseOptions(config.DATABASE_URL));
    let stopped = false;
    let disconnected = false;
    const disconnect = (error?: Error): void => {
      if (stopped || disconnected) return;
      disconnected = true;
      this.listeners.delete(client);
      onDisconnect(error);
    };
    client.on('notification', ({ channel, payload }) =>
      handler(channel, payload),
    );
    client.on('error', disconnect);
    client.on('end', disconnect);
    try {
      await client.connect();
      await Promise.all(
        channels.map((channel) =>
          client.query(`LISTEN ${quoteIdentifier(channel)}`),
        ),
      );
    } catch (error) {
      stopped = true;
      await client.end().catch(() => undefined);
      throw error;
    }
    this.listeners.add(client);
    this.logger.log(`listening on ${channels.join(', ')}`);
    return async () => {
      stopped = true;
      this.listeners.delete(client);
      await client.end();
    };
  }

  private pool(): pg.Pool {
    const replicaUrl = config.DATABASE_READ_REPLICA_URL;
    this.mainPool ??= this.createPool(
      replicaUrl ?? config.DATABASE_URL,
      replicaUrl
        ? DatabaseQueryRole.GraphqlReplica
        : DatabaseQueryRole.GraphqlPrimary,
      MIN_POOL_CLIENTS,
      replicaUrl ? config.DATABASE_QUERY_TIMEOUT_MS : undefined,
    );
    return this.mainPool;
  }

  private async validateEventStreamSchema(): Promise<void> {
    const [schema] = await this.queryLive<EventStreamSchema>(
      EVENT_STREAM_SCHEMA_QUERY,
    );
    if (!schema) throw new Error('Missing event stream schema result');
    const invalid = EVENT_STREAM_SCHEMA_CHECKS.filter((name) => !schema[name]);
    if (invalid.length) {
      throw new Error(
        `Event stream schema is not ready: ${invalid.join(', ')}`,
      );
    }
  }

  private live(): pg.Pool {
    this.livePool ??= this.createPool(
      config.DATABASE_URL,
      DatabaseQueryRole.LivePrimary,
    );
    return this.livePool;
  }

  private createPool(
    connectionString: string,
    role: DatabaseQueryRole,
    min?: number,
    connectionTimeoutMillis?: number,
  ): pg.Pool {
    const pool = new pg.Pool({
      ...databaseOptions(connectionString),
      connectionTimeoutMillis,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      max: MAX_POOL_CLIENTS,
      min,
    });
    pool.on('error', (error) =>
      this.logger.error(
        `idle database connection failed role=${role}: ${error.message}`,
      ),
    );
    return pool;
  }

  private async run<T extends pg.QueryResultRow>(
    pool: pg.Pool,
    role: DatabaseQueryRole,
    text: string,
    values: unknown[],
  ): Promise<T[]> {
    const id = ++this.nextQueryId;
    const started = Date.now();
    try {
      const result = await pool.query<T>(text, values);
      const duration = Date.now() - started;
      const rows = result.rowCount ?? 0;
      this.record(role, duration, rows);
      if (duration >= config.DATABASE_SLOW_QUERY_MS) {
        this.logger.warn(
          `slow query id=${id} role=${role} durationMs=${duration} rows=${rows} ${queryDetails(text, values)}`,
        );
      }
      return result.rows;
    } catch (error) {
      const duration = Date.now() - started;
      this.record(role, duration, 0, true);
      this.logger.warn(
        `query failed id=${id} role=${role} durationMs=${duration} error=${formatError(error)} ${queryDetails(text, values)}`,
      );
      throw error;
    }
  }

  private record(
    role: DatabaseQueryRole,
    duration: number,
    rows: number,
    failed = false,
  ): void {
    this.stats.queries++;
    this.stats.rows += rows;
    this.stats.totalMs += duration;
    this.stats.maxMs = Math.max(this.stats.maxMs, duration);
    if (failed) this.stats.errors++;
    databaseQueries.inc({ outcome: failed ? 'error' : 'success', role });
    databaseQueryDuration.observe(
      { outcome: failed ? 'error' : 'success', role },
      duration / 1_000,
    );
    databaseRows.inc({ role }, rows);
  }

  private logStats(): void {
    const { errors, maxMs, queries, rows, totalMs } = this.stats;
    this.stats = newStats();
    this.logger.log(
      `db stats queries=${queries} errors=${errors} rows=${rows} avgMs=${queries ? Math.round(totalMs / queries) : 0} maxMs=${maxMs} poolTotal=${this.mainPool?.totalCount ?? 0} poolIdle=${this.mainPool?.idleCount ?? 0} poolWaiting=${this.mainPool?.waitingCount ?? 0}`,
    );
  }
}

function poolMetrics(pool?: pg.Pool): DatabaseMetricsSnapshot['pools']['main'] {
  return {
    idle: pool?.idleCount ?? 0,
    limit: MAX_POOL_CLIENTS,
    total: pool?.totalCount ?? 0,
    waiting: pool?.waitingCount ?? 0,
  };
}

function databaseOptions(connectionString: string): pg.ClientConfig {
  return {
    connectionString,
    query_timeout: config.DATABASE_QUERY_TIMEOUT_MS,
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
  };
}

function newStats(): Stats {
  return { errors: 0, maxMs: 0, queries: 0, rows: 0, totalMs: 0 };
}

function json(value: unknown): string {
  return JSON.stringify(logValue(value));
}

function queryDetails(text: string, values: unknown[]): string {
  return `sql=${text.replaceAll(/\s+/g, ' ').trim()} values=${json(values)}`;
}

function logValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && value.length > 500)
    return `${value.slice(0, 500)}… (${value.length} chars)`;
  if (Buffer.isBuffer(value)) return logValue(`\\x${value.toString('hex')}`);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const items = value.map(logValue);
    return items.length <= 10
      ? items
      : { count: items.length, sample: [...items.slice(0, 8), '…'] };
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, logValue(item)]),
    );
  }
  return value;
}
