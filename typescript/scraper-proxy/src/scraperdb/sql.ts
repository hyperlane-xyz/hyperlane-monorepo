import { assert } from '@hyperlane-xyz/utils/validation';

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
type SelectSource = { relation: string; values: unknown[] };

export interface CountArgs {
  columns?: string[] | null;
  distinct?: boolean | null;
}

export interface SelectArgs {
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
  distinctColumns: 3,
  inItems: 200,
  limit: 500,
  offset: 5_000,
  orderColumns: 3,
};

export function buildSelect(
  table: TableName,
  args: SelectArgs = {},
  source?: SelectSource,
): Sql {
  const { cursor, orders } = validate(table, args);
  const values: unknown[] = [...(source?.values ?? [])];
  const filters = [
    where(table, args.where, values),
    cursorWhere(cursor, values),
  ].filter(Boolean);
  return {
    sql: `SELECT ${distinct(table, args.distinct_on)}${columns(table, args.columns)} FROM ${relation(table, source?.relation)}${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''}${orderBy(table, orders, cursor)}${limit(args.limit ?? MAX.limit, values)}${offset(args.offset, values)}`,
    values,
  };
}

export function buildCount(
  table: TableName,
  args: SelectArgs = {},
  count: CountArgs = {},
): Sql {
  const { cursor, orders } = validate(table, args);
  const countColumns = [...new Set(count.columns ?? [])];
  countColumns.forEach((column) => assertColumn(table, column));
  const values: unknown[] = [];
  const distinctClause = distinct(table, args.distinct_on);
  const filters = [
    where(table, args.where, values),
    cursorWhere(cursor, values),
  ].filter(Boolean);
  const whereClause = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const limitClause = limit(args.limit, values);
  const offsetClause = offset(args.offset, values);
  const source = `${relation(table)}${whereClause}`;
  const expression = countExpression(countColumns, count.distinct ?? false);
  return {
    sql:
      distinctClause || limitClause || offsetClause
        ? `SELECT ${expression}::int AS count FROM (SELECT ${distinctClause}${countColumns.length ? countColumns.map(q).join(', ') : '1'} FROM ${source}${orderBy(table, orders)}${limitClause}${offsetClause}) AS rows`
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
  assert(primaryKey, `${table} does not expose a primary-key query`);
  return {
    sql: `SELECT ${columns(table, selected)} FROM ${q(tables[table].relation ?? table)} WHERE ${q(primaryKey)} = $1 LIMIT 1`,
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

function relation(table: TableName, custom?: string): string {
  if (custom) return q(custom);
  // Provisional state is query metadata, not a stored message_view column.
  if (table === 'message_view') {
    return '(SELECT *, FALSE AS is_provisional FROM "message_view") AS "message_view"';
  }
  return q(tables[table].relation ?? table);
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
  let predicates = 0;
  return render(expression, 0);

  function render(
    expression: BoolExp | null | undefined,
    depth: number,
  ): string {
    if (!expression) return '';
    assert(
      depth <= MAX.boolDepth,
      `where exceeds maximum depth of ${MAX.boolDepth}`,
    );
    const rendered = Object.entries(expression)
      .map(([key, value]) => {
        predicates +=
          (key === '_and' || key === '_or') && Array.isArray(value)
            ? value.length
            : 1;
        assert(
          predicates <= MAX.boolPredicates,
          `where exceeds maximum of ${MAX.boolPredicates} predicates`,
        );
        return bool(key, value, depth);
      })
      .filter(Boolean);
    return rendered.length ? `(${rendered.join(' AND ')})` : '';
  }

  function bool(key: string, value: unknown, depth: number): string {
    if (value === null || value === undefined) return '';
    if (key === '_and' || key === '_or') {
      const children = Array.isArray(value) ? value : [value];
      if (key === '_or' && !children.length) return 'FALSE';
      const valueCount = values.length;
      const rendered = children
        .map((item) => render(boolExpression(item), depth + 1))
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
      const rendered = render(boolExpression(value), depth + 1);
      return rendered ? `NOT ${rendered}` : 'FALSE';
    }
    assertColumn(table, key);
    const rendered = Object.entries(boolExpression(value) ?? {})
      .map(([operator, operand]) =>
        comparison(q(key), operator, operand, values),
      )
      .filter(Boolean);
    return rendered.length ? `(${rendered.join(' AND ')})` : '';
  }
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
  assert(sqlOperator, `Unsupported comparison operator ${operator}`);
  if (operator === '_in' || operator === '_nin') {
    const items = Array.isArray(value) ? value : [];
    assert(
      items.length <= MAX.inItems,
      `${operator} exceeds maximum of ${MAX.inItems} items`,
    );
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

function cursorWhere(cursor: Cursor | undefined, values: unknown[]): string {
  return cursor
    ? `("id" ${cursor.ordering === 'DESC' ? '<' : '>'} ${bind(cursor.initial_value.id, values)})`
    : '';
}

function orderBy(
  table: TableName,
  columns: [string, Direction][],
  cursor?: Cursor,
): string {
  if (!columns.length && cursor)
    return ` ORDER BY "id" ${cursor.ordering === 'DESC' ? 'DESC' : 'ASC'}`;
  const rendered = columns.map(([column, direction]) =>
    order(table, column, direction),
  );
  return rendered.length ? ` ORDER BY ${rendered.join(', ')}` : '';
}

function order(table: TableName, column: string, direction: Direction): string {
  assertColumn(table, column);
  const [sort, , nulls] = direction.split('_');
  return `${q(column)} ${sort.toUpperCase()}${nulls ? ` NULLS ${nulls.toUpperCase()}` : ''}`;
}

function limit(value: number | null | undefined, values: unknown[]): string {
  return value == null ? '' : ` LIMIT ${bind(value, values)}`;
}

function offset(value: number | null | undefined, values: unknown[]): string {
  return value == null ? '' : ` OFFSET ${bind(value, values)}`;
}

function bind(value: unknown, values: unknown[]): string {
  values.push(value);
  return `$${values.length}`;
}

function validate(table: TableName, args: SelectArgs) {
  boundedInteger(args.limit, 'limit', MAX.limit);
  boundedInteger(args.offset, 'offset', MAX.offset);
  boundedColumns(args.distinct_on?.length, 'distinct_on', MAX.distinctColumns);
  const orders = Array.isArray(args.order_by)
    ? args.order_by
    : args.order_by
      ? [args.order_by]
      : [];
  const orderColumns = orders
    .flatMap(Object.entries)
    .filter((entry): entry is [string, Direction] => entry[1] != null);
  boundedColumns(orderColumns.length, 'order_by', MAX.orderColumns);
  const cursor = validateCursor(table, args.cursor, orderColumns);
  validateDistinctOrder(
    args.distinct_on,
    orderColumns.length
      ? orderColumns.map(([column]) => column)
      : cursor
        ? ['id']
        : [],
  );
  return { cursor, orders: orderColumns };
}

function validateCursor(
  table: TableName,
  cursors: Cursor[] | undefined,
  orderColumns: [string, Direction][],
): Cursor | undefined {
  if (!cursors?.length) return undefined;
  assert(table === 'message_view', 'Only message_view supports cursors');
  const cursor = cursors[0];
  assert(
    cursors.length === 1 && Object.keys(cursor.initial_value).length === 1,
    'message_view cursor must contain one column',
  );
  const [cursorColumn, cursorValue] = Object.entries(cursor.initial_value)[0];
  assert(cursorColumn === 'id', 'message_view cursor column must be id');
  assert(cursorValue != null, 'message_view cursor value must be non-null');
  if (!orderColumns.length) return cursor;

  const [orderColumn, orderDirection] = orderColumns[0] ?? [];
  assert(
    orderColumns.length === 1 &&
      cursorColumn === orderColumn &&
      (cursor.ordering === 'DESC') === orderDirection?.startsWith('desc'),
    'cursor columns and directions must match order_by',
  );
  return cursor;
}

function validateDistinctOrder(
  distinctColumns: string[] | null | undefined,
  orderColumns: string[],
): void {
  if (!distinctColumns?.length || !orderColumns.length) return;
  assert(
    !distinctColumns.some((column, index) => orderColumns[index] !== column),
    'distinct_on columns must match the leftmost order_by columns',
  );
}

function boundedInteger(
  value: number | null | undefined,
  name: string,
  max: number,
): void {
  if (value == null) return;
  assert(
    Number.isInteger(value) && value >= 0,
    `${name} must be a non-negative integer`,
  );
  assert(value <= max, `${name} exceeds maximum of ${max}`);
}

function boundedColumns(
  value: number | undefined,
  name: string,
  max: number,
): void {
  assert(!value || value <= max, `${name} exceeds maximum of ${max} columns`);
}
