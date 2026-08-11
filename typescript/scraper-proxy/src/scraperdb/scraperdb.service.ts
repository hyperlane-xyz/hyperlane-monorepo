import { Injectable } from '@nestjs/common';

import { DbService } from '../db/db.service.js';
import { buildByPk, buildCount, buildSelect, type SelectArgs } from './sql.js';
import type { TableName } from './tables.js';

type Row = Record<string, unknown>;
type AggregateResult = {
  aggregate: {
    count: number;
  };
};

@Injectable()
export class ScraperDbService {
  constructor(private readonly db: DbService) {}

  async select(table: TableName, args: SelectArgs): Promise<Row[]> {
    const query = buildSelect(table, args);
    return this.db.query<Row>(query.sql, query.values);
  }

  async byPk(
    table: TableName,
    id: unknown,
    columns?: string[],
  ): Promise<Row | null> {
    const query = buildByPk(table, id, columns);
    const [row] = await this.db.query<Row>(query.sql, query.values);
    return row ?? null;
  }

  async aggregate(
    table: TableName,
    args: SelectArgs,
  ): Promise<AggregateResult> {
    const query = buildCount(table, args);
    const [row] = await this.db.query<{ count: number }>(
      query.sql,
      query.values,
    );
    return { aggregate: { count: row?.count ?? 0 } };
  }
}
