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

const DEFAULT_SELECT_LIMIT = 500;
const MAX_LIMIT = 500;
const MAX_OFFSET = 5_000;
const MAX_ORDER_BY_COLUMNS = 3;
const MAX_DISTINCT_COLUMNS = 3;
const MAX_CURSOR_COLUMNS = 3;
const MAX_BOOL_DEPTH = 8;
const MAX_BOOL_PREDICATES = 100;
const MAX_IN_ITEMS = 200;

export function buildSelect(table: TableName, args: SelectArgs = {}): SqlParts {
  validateSelectArgs(args);
  const values: unknown[] = [];
  const distinct = buildDistinct(table, args.distinct_on);
  const where = buildWhere(table, args.where, values);
  const cursorWhere = buildCursorWhere(table, args.cursor, values);
  const orderBy = buildOrderBy(table, args.order_by, args.cursor);
  const limit = buildLimit(
    clampLimit(args.limit ?? args.batch_size ?? DEFAULT_SELECT_LIMIT),
    values,
  );
  const offset = buildOffset(args.offset, values);
  const filters = [where, cursorWhere].filter(Boolean);
  const whereClause = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';

  return {
    sql: `SELECT ${distinct}${quotedColumns(table, args.columns)} FROM ${quoteIdentifier(table)}${whereClause}${orderBy}${limit}${offset}`,
    values,
  };
}

export function buildCount(table: TableName, args: SelectArgs = {}): SqlParts {
  validateSelectArgs(args);
  const values: unknown[] = [];
  const distinct = buildDistinct(table, args.distinct_on);
  const where = buildWhere(table, args.where, values);
  const cursorWhere = buildCursorWhere(table, args.cursor, values);
  const limit =
    args.limit !== undefined || args.batch_size !== undefined
      ? buildLimit(clampLimit(args.limit ?? args.batch_size), values)
      : '';
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
  _lt: '<',
  _lte: '<=',
  _neq: '<>',
  _nin: 'NOT IN',
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

function validateSelectArgs(args: SelectArgs): void {
  validateLimit(args.limit, 'limit');
  validateLimit(args.batch_size, 'batch_size');
  validateOffset(args.offset);
  validateColumns(args.distinct_on, MAX_DISTINCT_COLUMNS, 'distinct_on');
  validateOrderBy(args.order_by);
  validateCursors(args.cursor);
  validateBoolExpressionShape(args.where);
}

function validateLimit(limit: number | undefined, name: string): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  if (limit > MAX_LIMIT) {
    throw new Error(`${name} exceeds maximum of ${MAX_LIMIT}`);
  }
}

function validateOffset(offset: number | undefined): void {
  if (offset === undefined) return;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('offset must be a non-negative integer');
  }
  if (offset > MAX_OFFSET) {
    throw new Error(`offset exceeds maximum of ${MAX_OFFSET}`);
  }
}

function validateColumns(
  columns: string[] | undefined,
  max: number,
  name: string,
): void {
  if (!columns?.length) return;
  if (columns.length > max) {
    throw new Error(`${name} exceeds maximum of ${max} columns`);
  }
}

function validateOrderBy(orderBy: SelectArgs['order_by']): void {
  const orderItems = Array.isArray(orderBy)
    ? orderBy
    : orderBy
      ? [orderBy]
      : [];
  const columnCount = orderItems.reduce(
    (sum, item) => sum + Object.keys(item).length,
    0,
  );
  if (columnCount > MAX_ORDER_BY_COLUMNS) {
    throw new Error(
      `order_by exceeds maximum of ${MAX_ORDER_BY_COLUMNS} columns`,
    );
  }
}

function validateCursors(cursors: StreamCursor[] | undefined): void {
  if (!cursors?.length) return;
  const columnCount = cursors.reduce(
    (sum, cursor) => sum + Object.keys(cursor.initial_value).length,
    0,
  );
  if (columnCount > MAX_CURSOR_COLUMNS) {
    throw new Error(`cursor exceeds maximum of ${MAX_CURSOR_COLUMNS} columns`);
  }
}

function validateBoolExpressionShape(where: BoolExp | undefined): void {
  const state = { predicates: 0 };
  visitBoolExpression(where, 0, state);
}

function visitBoolExpression(
  where: unknown,
  depth: number,
  state: { predicates: number },
): void {
  if (!where || typeof where !== 'object') return;
  if (depth > MAX_BOOL_DEPTH) {
    throw new Error(`where exceeds maximum depth of ${MAX_BOOL_DEPTH}`);
  }

  for (const [key, value] of Object.entries(where)) {
    if (key === '_and' || key === '_or') {
      const children = Array.isArray(value) ? value : [value];
      state.predicates += children.length;
      assertPredicateBudget(state);
      children.forEach((child) => visitBoolExpression(child, depth + 1, state));
      continue;
    }

    if (key === '_not') {
      state.predicates += 1;
      assertPredicateBudget(state);
      visitBoolExpression(value, depth + 1, state);
      continue;
    }

    state.predicates += 1;
    assertPredicateBudget(state);
    validateComparisonShape(value);
  }
}

function validateComparisonShape(comparison: unknown): void {
  if (!comparison || typeof comparison !== 'object') return;
  for (const [operator, value] of Object.entries(comparison)) {
    if (operator !== '_in' && operator !== '_nin') continue;
    const items = Array.isArray(value) ? value : [];
    if (items.length > MAX_IN_ITEMS) {
      throw new Error(`${operator} exceeds maximum of ${MAX_IN_ITEMS} items`);
    }
  }
}

function assertPredicateBudget(state: { predicates: number }): void {
  if (state.predicates > MAX_BOOL_PREDICATES) {
    throw new Error(
      `where exceeds maximum of ${MAX_BOOL_PREDICATES} predicates`,
    );
  }
}

function clampLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  return Math.min(limit, MAX_LIMIT);
}
