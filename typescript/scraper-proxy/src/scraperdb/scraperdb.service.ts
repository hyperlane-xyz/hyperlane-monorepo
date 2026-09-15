import {
  buildByPk,
  buildCount,
  buildSelect,
  type CountArgs,
  type SelectArgs,
} from './sql.js';
import type { TableName } from './tables.js';
import type { ScraperDbDatabase, ScraperDbRow } from './database.js';

type AggregateResult = {
  aggregate: { args: SelectArgs; table: TableName };
  nodes: ScraperDbRow[];
};

export class ScraperDbService {
  constructor(private readonly db: ScraperDbDatabase) {}

  async select(table: TableName, args: SelectArgs): Promise<ScraperDbRow[]> {
    const query = buildSelect(table, args);
    return this.db.query(query.sql, query.values);
  }

  async byPk(
    table: TableName,
    id: unknown,
    columns?: string[],
  ): Promise<ScraperDbRow | null> {
    const query = buildByPk(table, id, columns);
    const [row] = await this.db.query(query.sql, query.values);
    return row ?? null;
  }

  async aggregate(
    table: TableName,
    args: SelectArgs,
    columns?: string[],
  ): Promise<AggregateResult> {
    const select = columns && buildSelect(table, { ...args, columns });
    return {
      aggregate: { args, table },
      nodes: select ? await this.db.query(select.sql, select.values) : [],
    };
  }

  async count(
    table: TableName,
    selectArgs: SelectArgs,
    countArgs: CountArgs,
  ): Promise<number> {
    const query = buildCount(table, selectArgs, countArgs);
    const [row] = await this.db.query(query.sql, query.values);
    return typeof row?.count === 'number' ? row.count : 0;
  }
}
