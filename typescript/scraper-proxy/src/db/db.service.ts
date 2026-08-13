import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import pg from 'pg';

import { config } from '../config.js';

const POSTGRES_TIMESTAMP_OID = 1114;
const MIN_POOL_CLIENTS = 5;
const DB_STATS_INTERVAL_MS = 60_000;

pg.types.setTypeParser(POSTGRES_TIMESTAMP_OID, (value: string) => value);

@Injectable()
export class DbService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(DbService.name);
  private readonly listenerClients = new Set<pg.Client>();
  private stats: DbStats = emptyDbStats();
  private statsTimer?: NodeJS.Timeout;
  private pool?: pg.Pool;

  async query<T extends pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    const startedAt = Date.now();
    try {
      const result = await this.getPool().query<T>(text, values);
      const durationMs = Date.now() - startedAt;
      this.recordQueryStats(durationMs, result.rowCount ?? 0, false);
      this.logger.debug(`query ${durationMs}ms rows=${result.rowCount}`);
      return result.rows.map(normalizeRow) as T[];
    } catch (error) {
      this.recordQueryStats(Date.now() - startedAt, 0, true);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.statsTimer) clearInterval(this.statsTimer);
    await Promise.all(
      [...this.listenerClients].map(async (client) => client.end()),
    );
    await this.pool?.end();
  }

  async onModuleInit(): Promise<void> {
    const startedAt = Date.now();
    const clients = await Promise.all(
      Array.from({ length: MIN_POOL_CLIENTS }, () => this.getPool().connect()),
    );
    clients.forEach((client) => client.release());
    this.logger.log(
      `warmed ${MIN_POOL_CLIENTS} db connections in ${Date.now() - startedAt}ms`,
    );
    this.statsTimer = setInterval(() => this.logStats(), DB_STATS_INTERVAL_MS);
  }

  private getPool(): pg.Pool {
    const connectionString = normalizeConnectionString(config.DATABASE_URL);
    this.pool ??= new pg.Pool({
      connectionString,
      idleTimeoutMillis: 300_000,
      min: MIN_POOL_CLIENTS,
      ssl: connectionString.startsWith('postgres')
        ? { rejectUnauthorized: false }
        : undefined,
    });
    return this.pool;
  }

  async listen(
    channel: string,
    handler: (payload: string | undefined) => void,
  ): Promise<() => Promise<void>> {
    const client = new pg.Client(
      this.connectionOptions(config.LISTEN_DATABASE_URL),
    );
    client.on('notification', (message) => {
      if (message.channel === channel) {
        handler(message.payload);
      }
    });

    await client.connect();
    await client.query(`LISTEN ${quoteIdentifier(channel)}`);
    this.listenerClients.add(client);
    this.logger.log(`listening on ${channel}`);

    return async () => {
      this.listenerClients.delete(client);
      await client.query(`UNLISTEN ${quoteIdentifier(channel)}`);
      await client.end();
    };
  }

  private connectionOptions(
    connectionStringOverride?: string,
  ): pg.ClientConfig | pg.PoolConfig {
    const connectionString = normalizeConnectionString(
      connectionStringOverride ?? config.DATABASE_URL,
    );
    return {
      connectionString,
      ssl: connectionString.startsWith('postgres')
        ? { rejectUnauthorized: false }
        : undefined,
    };
  }

  private recordQueryStats(
    durationMs: number,
    rowCount: number,
    failed: boolean,
  ): void {
    this.stats.queries += 1;
    this.stats.rows += rowCount;
    this.stats.totalDurationMs += durationMs;
    this.stats.maxDurationMs = Math.max(this.stats.maxDurationMs, durationMs);
    if (failed) this.stats.errors += 1;
  }

  private logStats(): void {
    const stats = this.stats;
    this.stats = emptyDbStats();
    const pool = this.pool;
    const averageDurationMs = stats.queries
      ? Math.round(stats.totalDurationMs / stats.queries)
      : 0;
    this.logger.log(
      `db stats queries=${stats.queries} errors=${stats.errors} rows=${stats.rows} avgMs=${averageDurationMs} maxMs=${stats.maxDurationMs} poolTotal=${pool?.totalCount ?? 0} poolIdle=${pool?.idleCount ?? 0} poolWaiting=${pool?.waitingCount ?? 0}`,
    );
  }
}

type DbStats = {
  errors: number;
  maxDurationMs: number;
  queries: number;
  rows: number;
  totalDurationMs: number;
};

function emptyDbStats(): DbStats {
  return {
    errors: 0,
    maxDurationMs: 0,
    queries: 0,
    rows: 0,
    totalDurationMs: 0,
  };
}

function normalizeConnectionString(connectionString: string): string {
  if (!connectionString.startsWith('postgres')) {
    return connectionString;
  }

  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  return url.toString();
}

function normalizeRow(row: pg.QueryResultRow): pg.QueryResultRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      Buffer.isBuffer(value) ? `\\x${value.toString('hex')}` : value,
    ]),
  );
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
