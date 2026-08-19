import { Injectable } from '@nestjs/common';

import { DbService } from '../db/db.service.js';
import { buildByPk, buildCount, buildSelect, type SelectArgs } from './sql.js';
import type { TableName } from './tables.js';

type Row = Record<string, unknown>;
type AggregateResult = {
  aggregate: {
    count: number;
  };
  nodes: Row[];
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
    columns?: string[],
  ): Promise<AggregateResult> {
    const count = buildCount(table, args);
    const select = columns ? buildSelect(table, { ...args, columns }) : null;
    const [[row], nodes] = await Promise.all([
      this.db.query<{ count: number }>(count.sql, count.values),
      select
        ? this.db.query<Row>(select.sql, select.values)
        : Promise.resolve([]),
    ]);
    return { aggregate: { count: row?.count ?? 0 }, nodes };
  }
}
