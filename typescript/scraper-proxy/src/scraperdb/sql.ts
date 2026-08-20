import {
  assertColumn,
  quoteIdentifier as q,
  tables,
  type TableName,
} from './tables.js';

type Direction =
  | 'asc'
  | 'asc_nulls_first'
  | 'asc_nulls_last'
  | 'desc'
  | 'desc_nulls_first'
  | 'desc_nulls_last';
type Order = Record<string, Direction | null | undefined>;
type Cursor = {
  initial_value: Record<string, unknown>;
  ordering?: 'ASC' | 'DESC';
};
type BoolExp = Record<string, unknown>;
type Sql = { sql: string; values: unknown[] };

export interface CountArgs {
  columns?: string[] | null;
  distinct?: boolean | null;
}

export interface SelectArgs {
  batch_size?: number | null;
  columns?: string[];
  cursor?: Cursor[];
  distinct_on?: string[] | null;
  limit?: number | null;
  offset?: number | null;
  order_by?: Order | Order[] | null;
  where?: BoolExp | null;
}

const MAX = {
  boolDepth: 8,
  boolPredicates: 100,
  cursorColumns: 3,
  distinctColumns: 3,
  inItems: 200,
  limit: 500,
  offset: 5_000,
  orderColumns: 3,
};

export function buildSelect(table: TableName, args: SelectArgs = {}): Sql {
  validate(args);
  const values: unknown[] = [];
  const filters = [
    where(table, args.where, values),
    cursorWhere(table, args.cursor, values),
  ].filter(Boolean);
  return {
    sql: `SELECT ${distinct(table, args.distinct_on)}${columns(table, args.columns)} FROM ${q(table)}${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''}${orderBy(table, args.order_by, args.cursor)}${limit(args.limit ?? args.batch_size ?? MAX.limit, values)}${offset(args.offset, values)}`,
    values,
  };
}

export function buildCount(
  table: TableName,
  args: SelectArgs = {},
  count: CountArgs = {},
): Sql {
  validate(args);
  const countColumns = [...new Set(count.columns ?? [])];
  countColumns.forEach((column) => assertColumn(table, column));
  const values: unknown[] = [];
  const distinctClause = distinct(table, args.distinct_on);
  const filters = [
    where(table, args.where, values),
    cursorWhere(table, args.cursor, values),
  ].filter(Boolean);
  const whereClause = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const limitClause =
    args.limit == null && args.batch_size == null
      ? ''
      : limit(args.limit ?? args.batch_size, values);
  const offsetClause = offset(args.offset, values);
  const source = `${q(table)}${whereClause}`;
  const expression = countExpression(countColumns, count.distinct ?? false);
  return {
    sql:
      distinctClause || limitClause || offsetClause
        ? `SELECT ${expression}::int AS count FROM (SELECT ${distinctClause}${countColumns.length ? countColumns.map(q).join(', ') : '1'} FROM ${source}${orderBy(table, args.order_by)}${limitClause}${offsetClause}) AS rows`
        : `SELECT ${expression}::int AS count FROM ${source}`,
    values,
  };
}

function countExpression(columns: string[], distinct = false): string {
  if (!columns.length) return 'COUNT(*)';
  const value =
    columns.length === 1 ? q(columns[0]) : `(${columns.map(q).join(', ')})`;
  return `COUNT(${distinct ? 'DISTINCT ' : ''}${value})`;
}

export function buildByPk(
  table: TableName,
  id: unknown,
  selected?: string[],
): Sql {
  const primaryKey = tables[table].primaryKey;
  if (!primaryKey)
    throw new Error(`${table} does not expose a primary-key query`);
  return {
    sql: `SELECT ${columns(table, selected)} FROM ${q(table)} WHERE ${q(primaryKey)} = $1 LIMIT 1`,
    values: [id],
  };
}

function columns(table: TableName, selected = tables[table].columns): string {
  const allowed = [...new Set(selected)].filter((column) =>
    tables[table].columnSet.has(column),
  );
  return (
    allowed.length
      ? allowed
      : [tables[table].primaryKey ?? tables[table].columns[0]]
  )
    .map(q)
    .join(', ');
}

function distinct(table: TableName, selected?: string[] | null): string {
  if (!selected?.length) return '';
  selected.forEach((column) => assertColumn(table, column));
  return `DISTINCT ON (${selected.map(q).join(', ')}) `;
}

function where(
  table: TableName,
  expression: BoolExp | null | undefined,
  values: unknown[],
): string {
  if (!expression) return '';
  const rendered = Object.entries(expression)
    .map(([key, value]) => bool(table, key, value, values))
    .filter(Boolean);
  return rendered.length ? `(${rendered.join(' AND ')})` : '';
}

function bool(
  table: TableName,
  key: string,
  value: unknown,
  values: unknown[],
): string {
  if (value === null || value === undefined) return '';
  if (key === '_and' || key === '_or') {
    const children = Array.isArray(value) ? value : [value];
    if (key === '_or' && !children.length) return 'FALSE';
    const valueCount = values.length;
    const rendered = children
      .map((item) => where(table, boolExpression(item), values))
      .filter(Boolean);
    if (key === '_or' && rendered.length < children.length) {
      values.length = valueCount;
      return '';
    }
    return rendered.length
      ? `(${rendered.join(key === '_and' ? ' AND ' : ' OR ')})`
      : '';
  }
  if (key === '_not') {
    const rendered = where(table, boolExpression(value), values);
    return rendered ? `NOT ${rendered}` : 'FALSE';
  }
  assertColumn(table, key);
  const rendered = Object.entries(boolExpression(value) ?? {})
    .map(([operator, operand]) => comparison(q(key), operator, operand, values))
    .filter(Boolean);
  return rendered.length ? `(${rendered.join(' AND ')})` : '';
}

function comparison(
  column: string,
  operator: string,
  value: unknown,
  values: unknown[],
): string {
  if (value === null || value === undefined) return '';
  if (operator === '_is_null') return `${column} IS ${value ? '' : 'NOT '}NULL`;
  const sqlOperator = OPERATORS[operator];
  if (!sqlOperator)
    throw new Error(`Unsupported comparison operator ${operator}`);
  if (operator === '_in' || operator === '_nin') {
    const items = Array.isArray(value) ? value : [];
    if (!items.length) return operator === '_in' ? 'FALSE' : 'TRUE';
    return `${column} ${operator === '_in' ? '= ANY' : '<> ALL'}(${bind(items, values)})`;
  }
  return `${column} ${sqlOperator} ${bind(value, values)}`;
}

const OPERATORS: Record<string, string> = {
  _eq: '=',
  _gt: '>',
  _gte: '>=',
  _in: 'IN',
  _lt: '<',
  _lte: '<=',
  _neq: '<>',
  _nin: 'NOT IN',
};

function boolExpression(value: unknown): BoolExp | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cursorWhere(
  table: TableName,
  cursors: Cursor[] | undefined,
  values: unknown[],
): string {
  if (!cursors?.length) return '';
  const rendered = cursors.flatMap((cursor) =>
    Object.entries(cursor.initial_value).map(([column, value]) => {
      assertColumn(table, column);
      return `${q(column)} ${cursor.ordering === 'DESC' ? '<' : '>'} ${bind(value, values)}`;
    }),
  );
  return rendered.length ? `(${rendered.join(' AND ')})` : '';
}

function orderBy(
  table: TableName,
  requested: SelectArgs['order_by'],
  cursors?: Cursor[],
): string {
  const items = Array.isArray(requested)
    ? requested
    : requested
      ? [requested]
      : [];
  const rendered = items.flatMap((item) =>
    Object.entries(item).flatMap(([column, direction]) =>
      direction == null ? [] : [order(table, column, direction)],
    ),
  );
  if (!rendered.length) {
    rendered.push(
      ...(cursors ?? []).flatMap((cursor) =>
        Object.keys(cursor.initial_value).map((column) =>
          order(table, column, cursor.ordering === 'DESC' ? 'desc' : 'asc'),
        ),
      ),
    );
  }
  return rendered.length ? ` ORDER BY ${rendered.join(', ')}` : '';
}

function order(table: TableName, column: string, direction: Direction): string {
  assertColumn(table, column);
  const [sort, , nulls] = direction.split('_');
  return `${q(column)} ${sort.toUpperCase()}${nulls ? ` NULLS ${nulls.toUpperCase()}` : ''}`;
}

function limit(value: number | null | undefined, values: unknown[]): string {
  return value == null
    ? ''
    : ` LIMIT ${bind(Math.min(value, MAX.limit), values)}`;
}

function offset(value: number | null | undefined, values: unknown[]): string {
  return value == null ? '' : ` OFFSET ${bind(value, values)}`;
}

function bind(value: unknown, values: unknown[]): string {
  values.push(value);
  return `$${values.length}`;
}

function validate(args: SelectArgs): void {
  boundedInteger(args.limit, 'limit', MAX.limit);
  boundedInteger(args.batch_size, 'batch_size', MAX.limit);
  boundedInteger(args.offset, 'offset', MAX.offset);
  boundedColumns(args.distinct_on?.length, 'distinct_on', MAX.distinctColumns);
  const orders = Array.isArray(args.order_by)
    ? args.order_by
    : args.order_by
      ? [args.order_by]
      : [];
  boundedColumns(
    orders.reduce(
      (total, item) =>
        total + Object.values(item).filter((value) => value != null).length,
      0,
    ),
    'order_by',
    MAX.orderColumns,
  );
  validateDistinctOrder(args.distinct_on, orders);
  boundedColumns(
    args.cursor?.reduce(
      (total, item) => total + Object.keys(item.initial_value).length,
      0,
    ),
    'cursor',
    MAX.cursorColumns,
  );
  const state = { predicates: 0 };
  validateWhere(args.where, 0, state);
}

function validateDistinctOrder(
  distinctColumns: string[] | null | undefined,
  orders: Order[],
): void {
  if (!distinctColumns?.length || !orders.length) return;
  const orderColumns = orders.flatMap((order) =>
    Object.entries(order).flatMap(([column, direction]) =>
      direction == null ? [] : [column],
    ),
  );
  if (distinctColumns.some((column, index) => orderColumns[index] !== column)) {
    throw new Error(
      'distinct_on columns must match the leftmost order_by columns',
    );
  }
}

function boundedInteger(
  value: number | null | undefined,
  name: string,
  max: number,
): void {
  if (value == null) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  if (value > max) throw new Error(`${name} exceeds maximum of ${max}`);
}

function boundedColumns(
  value: number | undefined,
  name: string,
  max: number,
): void {
  if (value && value > max)
    throw new Error(`${name} exceeds maximum of ${max} columns`);
}

function validateWhere(
  value: unknown,
  depth: number,
  state: { predicates: number },
): void {
  if (!value || typeof value !== 'object') return;
  if (depth > MAX.boolDepth)
    throw new Error(`where exceeds maximum depth of ${MAX.boolDepth}`);
  for (const [key, child] of Object.entries(value)) {
    if (key === '_and' || key === '_or') {
      const children = Array.isArray(child) ? child : [child];
      addPredicates(state, children.length);
      children.forEach((item) => validateWhere(item, depth + 1, state));
    } else if (key === '_not') {
      addPredicates(state, 1);
      validateWhere(child, depth + 1, state);
    } else {
      addPredicates(state, 1);
      if (!child || typeof child !== 'object') continue;
      for (const [operator, items] of Object.entries(child)) {
        if (
          (operator === '_in' || operator === '_nin') &&
          Array.isArray(items) &&
          items.length > MAX.inItems
        ) {
          throw new Error(
            `${operator} exceeds maximum of ${MAX.inItems} items`,
          );
        }
      }
    }
  }
}

function addPredicates(state: { predicates: number }, count: number): void {
  state.predicates += count;
  if (state.predicates > MAX.boolPredicates) {
    throw new Error(
      `where exceeds maximum of ${MAX.boolPredicates} predicates`,
    );
  }
}
