import { assert } from '@hyperlane-xyz/utils';

import {
  buildProvisionalMessageAffectedQuery,
  PROVISIONAL_MESSAGE_PROJECTION_QUERY,
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
    const messageFilter = selectArgs.where?.msg_id;
    const messageId =
      messageFilter != null &&
      typeof messageFilter === 'object' &&
      '_eq' in messageFilter
        ? messageFilter._eq
        : undefined;
    const filterByMessageId = messageId != null;
    // Branches retain every column used by outer filters, ordering, or DISTINCT.
    const branchArgs = { ...selectArgs, columns: undefined, offset: undefined };
    const canonicalQuery = buildSelect('message_view', branchArgs, {
      relation: 'canonical_message_view',
      values: filterByMessageId ? [confirmations, messageId] : [confirmations],
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
      `WITH custom_frontier AS (
        SELECT domain, least(indexed_height, head_height-$1::integer) AS height,
          confirmed_height FROM scraper_head
      ),
      affected_message(msg_id) AS (${buildProvisionalMessageAffectedQuery(filterByMessageId)}),
      affected_projection AS (
        SELECT projection.*, TRUE AS is_provisional
        FROM (${PROVISIONAL_MESSAGE_PROJECTION_QUERY}) projection
      ),
      canonical_message_view AS (
        SELECT canonical.*, FALSE AS is_provisional FROM message_view canonical
        WHERE canonical.msg_id NOT IN (SELECT msg_id FROM affected_projection
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
