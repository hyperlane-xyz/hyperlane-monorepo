import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import pg from 'pg';

import { config } from '../config.js';
import type { DatabaseMetricsSnapshot } from '../metrics.js';
import { quoteIdentifier } from '../scraperdb/tables.js';

const MIN_POOL_CLIENTS = 5;
const MAX_POOL_CLIENTS = 10;
const STATS_INTERVAL_MS = 60_000;
const IDLE_TIMEOUT_MS = 300_000;

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
    const started = Date.now();
    const clients = await Promise.all(
      Array.from({ length: MIN_POOL_CLIENTS }, () => this.pool().connect()),
    );
    clients.forEach((client) => client.release());
    this.logger.log(
      `warmed ${MIN_POOL_CLIENTS} db connections in ${Date.now() - started}ms`,
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
      this.logger.error(`database shutdown failed: ${errorMessage(error)}`),
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
    return this.run(this.pool(), text, values);
  }

  queryLive<T extends pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return this.run(this.live(), text, values);
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
    this.mainPool ??= this.createPool(config.DATABASE_URL, MIN_POOL_CLIENTS);
    return this.mainPool;
  }

  private live(): pg.Pool {
    this.livePool ??= this.createPool(config.DATABASE_URL);
    return this.livePool;
  }

  private createPool(connectionString: string, min?: number): pg.Pool {
    const pool = new pg.Pool({
      ...databaseOptions(connectionString),
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      max: MAX_POOL_CLIENTS,
      min,
    });
    pool.on('error', (error) =>
      this.logger.error(`idle database connection failed: ${error.message}`),
    );
    return pool;
  }

  private async run<T extends pg.QueryResultRow>(
    pool: pg.Pool,
    text: string,
    values: unknown[],
  ): Promise<T[]> {
    const id = ++this.nextQueryId;
    const started = Date.now();
    this.logger.debug(
      `query id=${id} start sql=${text.replaceAll(/\s+/g, ' ').trim()} values=${json(values)}`,
    );
    try {
      const result = await pool.query<T>(text, values);
      const duration = Date.now() - started;
      this.record(duration, result.rowCount ?? 0);
      this.logger.debug(
        `query id=${id} completed ${duration}ms rows=${result.rowCount}`,
      );
      return result.rows;
    } catch (error) {
      const duration = Date.now() - started;
      this.record(duration, 0, true);
      this.logger.debug(
        `query id=${id} failed ${duration}ms error=${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private record(duration: number, rows: number, failed = false): void {
    this.stats.queries++;
    this.stats.rows += rows;
    this.stats.totalMs += duration;
    this.stats.maxMs = Math.max(this.stats.maxMs, duration);
    if (failed) this.stats.errors++;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
