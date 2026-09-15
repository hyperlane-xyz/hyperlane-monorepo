import {
  buildByPk,
  buildCount,
  buildSelect,
  type CountArgs,
  type SelectArgs,
} from './sql.js';
import type { TableName } from './tables.js';

type Row = Record<string, unknown>;
export type ScraperDbDatabase = {
  query(text: string, values?: unknown[]): Promise<Row[]>;
};
type AggregateResult = {
  aggregate: { args: SelectArgs; table: TableName };
  nodes: Row[];
};

export class ScraperDbService {
  constructor(private readonly db: ScraperDbDatabase) {}

  async select(table: TableName, args: SelectArgs): Promise<Row[]> {
    const query = buildSelect(table, args);
    return this.db.query(query.sql, query.values);
  }

  async byPk(
    table: TableName,
    id: unknown,
    columns?: string[],
  ): Promise<Row | null> {
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
