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

pg.types.setTypeParser(POSTGRES_TIMESTAMP_OID, (value: string) => value);

@Injectable()
export class DbService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(DbService.name);
  private pool?: pg.Pool;

  async query<T extends pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    const startedAt = Date.now();
    const result = await this.getPool().query<T>(text, values);
    this.logger.log(
      `query ${Date.now() - startedAt}ms rows=${result.rowCount}`,
    );
    return result.rows.map(normalizeRow) as T[];
  }

  async onModuleDestroy(): Promise<void> {
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
