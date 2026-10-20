import { assert } from '@hyperlane-xyz/utils';

import {
  buildProvisionalMessageAffectedQuery,
  PROJECTED_MESSAGE_QUERY,
  PROVISIONAL_MESSAGE_QUERY,
} from '../live/provisional-message.js';
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

export interface MessageSelectArgs extends SelectArgs {
  confirmations?: number | null;
}

// Bound unauthenticated custom-frontier scans; larger history uses canonical queries.
const MAX_CONFIRMATIONS = 1_000;
const MAX_AFFECTED_EVENTS = 10_000;

export class ScraperDbService {
  constructor(private readonly db: ScraperDbDatabase) {}

  async select(table: TableName, args: SelectArgs): Promise<ScraperDbRow[]> {
    const query = buildSelect(table, args);
    return this.db.query(query.sql, query.values);
  }

  async selectMessages(args: MessageSelectArgs): Promise<ScraperDbRow[]> {
    const { confirmations, ...selectArgs } = args;
    if (confirmations == null) return this.select('message_view', selectArgs);
    assert(
      Number.isSafeInteger(confirmations) && confirmations >= 0,
      'confirmations must be a non-negative safe integer',
    );
    assert(
      confirmations <= MAX_CONFIRMATIONS,
      `confirmations exceeds maximum of ${MAX_CONFIRMATIONS}`,
    );
    assert(!selectArgs.offset, 'offset is unsupported with confirmations');
    assert(
      !selectArgs.cursor?.length,
      'cursor is unsupported with confirmations; paginate canonical history separately',
    );
    // Validate filters before either database query, including recursive limits.
    buildSelect('message_view', selectArgs);
    const ids = messageIds(selectArgs.where);
    const [snapshot] = await this.db.query(
      `WITH custom_frontier AS (
        SELECT domain, least(indexed_height, head_height-$1::integer) AS height,
          confirmed_height FROM scraper_head
      ), affected AS MATERIALIZED (
        SELECT msg_id FROM (${buildProvisionalMessageAffectedQuery(ids !== undefined)}) events
          LIMIT ${MAX_AFFECTED_EVENTS + 1}
      ) SELECT array_agg(domain) AS domains, array_agg(height::text) AS heights,
        CASE WHEN (SELECT count(*) FROM affected)>${MAX_AFFECTED_EVENTS}
          THEN NULL ELSE ARRAY(SELECT msg_id FROM affected) END AS message_ids
        FROM custom_frontier`,
      ids === undefined ? [confirmations] : [confirmations, ids],
    );
    assert(snapshot, 'Missing confirmation snapshot');
    assert(
      snapshot.message_ids !== null,
      `Confirmation snapshot exceeds ${MAX_AFFECTED_EVENTS} affected events; query canonical history or narrow msg_id`,
    );
    assert(
      Array.isArray(snapshot.message_ids),
      'Invalid confirmation snapshot',
    );
    // Branches retain every column used by outer filters, ordering, or DISTINCT.
    const branchArgs = { ...selectArgs, columns: undefined, offset: undefined };
    const canonicalQuery = buildSelect('message_view', branchArgs, {
      relation: 'canonical_message_view',
      values: [snapshot.message_ids, snapshot.domains, snapshot.heights],
    });
    const projectedQuery = buildSelect('message_view', branchArgs, {
      relation: 'affected_projection',
      values: canonicalQuery.values,
    });
    const query = buildSelect('message_view', selectArgs, {
      relation: 'provisional_message_view',
      values: projectedQuery.values,
    });
    return this.db.query(
      `WITH custom_frontier(domain, height) AS (
        SELECT * FROM unnest($2::integer[], $3::bigint[])
      ), projected_message AS (${PROJECTED_MESSAGE_QUERY}),
      affected_projection AS (
        SELECT projection.*, TRUE AS is_provisional
        FROM (${PROVISIONAL_MESSAGE_QUERY}) projection
      ),
      canonical_message_view AS (
        SELECT canonical.*, FALSE AS is_provisional FROM message_view canonical
        WHERE canonical.msg_id NOT IN (SELECT msg_id FROM projected_message
          WHERE msg_id IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM custom_frontier frontier
            WHERE frontier.domain=canonical.origin_domain_id
              AND canonical.origin_block_height>frontier.height)
          AND NOT EXISTS (SELECT 1 FROM raw_message_dispatch dispatch
            JOIN custom_frontier frontier ON frontier.domain=dispatch.origin_domain
            WHERE dispatch.msg_id=canonical.msg_id
              AND dispatch.origin_block_height>frontier.height)
      ), provisional_message_view AS (
        (${canonicalQuery.sql}) UNION ALL (${projectedQuery.sql})
      ) ${query.sql}`,
      query.values,
    );
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
    assert(typeof row?.count === 'number', 'Invalid database count result');
    return row.count;
  }
}

// Return a necessary msg_id bound, never narrowing an unbounded OR branch.
function messageIds(where: unknown): unknown[] | undefined {
  if (!where || typeof where !== 'object' || Array.isArray(where))
    return undefined;
  if ('msg_id' in where && where.msg_id && typeof where.msg_id === 'object') {
    if ('_eq' in where.msg_id && where.msg_id._eq != null)
      return [where.msg_id._eq];
    if ('_in' in where.msg_id && Array.isArray(where.msg_id._in))
      return where.msg_id._in;
  }
  if ('_and' in where) {
    for (const child of Array.isArray(where._and) ? where._and : [where._and]) {
      const ids = messageIds(child);
      if (ids !== undefined) return ids;
    }
  }
  if ('_or' in where) {
    const children = Array.isArray(where._or) ? where._or : [where._or];
    const bounds = children.map(messageIds);
    if (bounds.every((ids) => ids !== undefined)) return bounds.flat();
  }
  return undefined;
}
