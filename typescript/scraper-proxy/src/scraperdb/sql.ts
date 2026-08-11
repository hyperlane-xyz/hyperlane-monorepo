import {
  assertColumn,
  quoteIdentifier,
  tables,
  type TableName,
} from './tables.js';

type OrderDirection =
  | 'asc'
  | 'asc_nulls_first'
  | 'asc_nulls_last'
  | 'desc'
  | 'desc_nulls_first'
  | 'desc_nulls_last';

export interface SelectArgs {
  batch_size?: number;
  columns?: string[];
  cursor?: StreamCursor[];
  distinct_on?: string[];
  limit?: number;
  offset?: number;
  order_by?: Record<string, OrderDirection> | Record<string, OrderDirection>[];
  where?: BoolExp;
}

interface StreamCursor {
  initial_value: Record<string, unknown>;
  ordering?: 'ASC' | 'DESC';
}

type BoolExp = Record<string, unknown>;

interface SqlParts {
  sql: string;
  values: unknown[];
}

export function buildSelect(table: TableName, args: SelectArgs = {}): SqlParts {
  const values: unknown[] = [];
  const distinct = buildDistinct(table, args.distinct_on);
  const where = buildWhere(table, args.where, values);
  const cursorWhere = buildCursorWhere(table, args.cursor, values);
  const orderBy = buildOrderBy(table, args.order_by, args.cursor);
  const limit = buildLimit(args.limit ?? args.batch_size, values);
  const offset = buildOffset(args.offset, values);
  const filters = [where, cursorWhere].filter(Boolean);
  const whereClause = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';

  return {
    sql: `SELECT ${distinct}${quotedColumns(table, args.columns)} FROM ${quoteIdentifier(table)}${whereClause}${orderBy}${limit}${offset}`,
    values,
  };
}

export function buildCount(table: TableName, args: SelectArgs = {}): SqlParts {
  const values: unknown[] = [];
  const distinct = buildDistinct(table, args.distinct_on);
  const where = buildWhere(table, args.where, values);
  const cursorWhere = buildCursorWhere(table, args.cursor, values);
  const limit = buildLimit(args.limit ?? args.batch_size, values);
  const offset = buildOffset(args.offset, values);
  const filters = [where, cursorWhere].filter(Boolean);
  const whereClause = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const hasWindow = distinct || limit || offset;

  return {
    sql: hasWindow
      ? `SELECT COUNT(*)::int AS count FROM (SELECT ${distinct}1 FROM ${quoteIdentifier(table)}${whereClause}${limit}${offset}) AS rows`
      : `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(table)}${whereClause}`,
    values,
  };
}

export function buildByPk(
  table: TableName,
  id: unknown,
  columns?: string[],
): SqlParts {
  const primaryKey = tables[table].primaryKey;
  if (!primaryKey) {
    throw new Error(`${table} does not expose a primary-key query`);
  }

  return {
    sql: `SELECT ${quotedColumns(table, columns)} FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(primaryKey)} = $1 LIMIT 1`,
    values: [id],
  };
}

function quotedColumns(
  table: TableName,
  columns = tables[table].columns,
): string {
  const selectedColumns = [...new Set(columns)].filter((column) =>
    tables[table].columnSet.has(column),
  );
  if (!selectedColumns.length) {
    return quoteIdentifier(
      tables[table].primaryKey ?? tables[table].columns[0],
    );
  }

  return selectedColumns.map(quoteIdentifier).join(', ');
}

function buildDistinct(
  table: TableName,
  columns: string[] | undefined,
): string {
  if (!columns?.length) {
    return '';
  }

  columns.forEach((column) => assertColumn(table, column));
  return `DISTINCT ON (${columns.map(quoteIdentifier).join(', ')}) `;
}

function buildWhere(
  table: TableName,
  where: BoolExp | undefined,
  values: unknown[],
): string {
  if (!where) {
    return '';
  }

  const expressions = Object.entries(where)
    .map(([key, value]) => buildBoolExpression(table, key, value, values))
    .filter(Boolean);

  return expressions.length ? `(${expressions.join(' AND ')})` : '';
}

function buildBoolExpression(
  table: TableName,
  key: string,
  value: unknown,
  values: unknown[],
): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (key === '_and' || key === '_or') {
    const children = Array.isArray(value) ? value : [value];
    const rendered = children
      .map((child) => buildWhere(table, child as BoolExp, values))
      .filter(Boolean);
    const joiner = key === '_and' ? ' AND ' : ' OR ';
    return rendered.length ? `(${rendered.join(joiner)})` : '';
  }

  if (key === '_not') {
    const rendered = buildWhere(table, value as BoolExp, values);
    return rendered ? `NOT ${rendered}` : '';
  }

  assertColumn(table, key);
  return buildComparison(
    quoteIdentifier(key),
    value as Record<string, unknown>,
    values,
  );
}

function buildComparison(
  column: string,
  comparison: Record<string, unknown>,
  values: unknown[],
): string {
  const expressions = Object.entries(comparison)
    .map(([operator, value]) =>
      buildComparisonOperator(column, operator, value, values),
    )
    .filter(Boolean);

  return expressions.length ? `(${expressions.join(' AND ')})` : '';
}

function buildComparisonOperator(
  column: string,
  operator: string,
  value: unknown,
  values: unknown[],
): string {
  if (operator === '_is_null') {
    return value ? `${column} IS NULL` : `${column} IS NOT NULL`;
  }

  const sqlOperator = comparisonOperators[operator];
  if (!sqlOperator) {
    throw new Error(`Unsupported comparison operator ${operator}`);
  }

  if (operator === '_in' || operator === '_nin') {
    const items = Array.isArray(value) ? value : [];
    if (!items.length) {
      return operator === '_in' ? 'FALSE' : 'TRUE';
    }
    const placeholders = items
      .map((item) => bindValue(item, values))
      .join(', ');
    return `${column} ${sqlOperator} (${placeholders})`;
  }

  return `${column} ${sqlOperator} ${bindValue(value, values)}`;
}

const comparisonOperators: Record<string, string> = {
  _eq: '=',
  _gt: '>',
  _gte: '>=',
  _ilike: 'ILIKE',
  _iregex: '~*',
  _like: 'LIKE',
  _lt: '<',
  _lte: '<=',
  _neq: '<>',
  _nilike: 'NOT ILIKE',
  _niregex: '!~*',
  _nin: 'NOT IN',
  _nlike: 'NOT LIKE',
  _nregex: '!~',
  _nsimilar: 'NOT SIMILAR TO',
  _regex: '~',
  _similar: 'SIMILAR TO',
  _in: 'IN',
};

function buildCursorWhere(
  table: TableName,
  cursors: StreamCursor[] | undefined,
  values: unknown[],
): string {
  if (!cursors?.length) {
    return '';
  }

  const expressions = cursors.flatMap((cursor) =>
    Object.entries(cursor.initial_value).map(([column, value]) => {
      assertColumn(table, column);
      const operator = cursor.ordering === 'DESC' ? '<=' : '>=';
      return `${quoteIdentifier(column)} ${operator} ${bindValue(value, values)}`;
    }),
  );

  return expressions.length ? `(${expressions.join(' AND ')})` : '';
}

function buildOrderBy(
  table: TableName,
  orderBy: SelectArgs['order_by'],
  cursors: StreamCursor[] | undefined,
): string {
  const orderItems = Array.isArray(orderBy)
    ? orderBy
    : orderBy
      ? [orderBy]
      : [];
  const rendered = orderItems.flatMap((item) =>
    Object.entries(item).map(([column, direction]) =>
      renderOrderBy(table, column, direction),
    ),
  );

  if (!rendered.length && cursors?.length) {
    rendered.push(
      ...cursors.flatMap((cursor) =>
        Object.keys(cursor.initial_value).map((column) =>
          renderOrderBy(
            table,
            column,
            cursor.ordering === 'DESC' ? 'desc' : 'asc',
          ),
        ),
      ),
    );
  }

  return rendered.length ? ` ORDER BY ${rendered.join(', ')}` : '';
}

function renderOrderBy(
  table: TableName,
  column: string,
  direction: OrderDirection,
): string {
  assertColumn(table, column);
  const [order, ...nulls] = direction.split('_');
  const nullsClause = nulls.length ? ` NULLS ${nulls[1]?.toUpperCase()}` : '';
  return `${quoteIdentifier(column)} ${order.toUpperCase()}${nullsClause}`;
}

function buildLimit(limit: number | undefined, values: unknown[]): string {
  if (limit === undefined) {
    return '';
  }
  return ` LIMIT ${bindValue(limit, values)}`;
}

function buildOffset(offset: number | undefined, values: unknown[]): string {
  if (offset === undefined) {
    return '';
  }
  return ` OFFSET ${bindValue(offset, values)}`;
}

function bindValue(value: unknown, values: unknown[]): string {
  values.push(value);
  return `$${values.length}`;
}
