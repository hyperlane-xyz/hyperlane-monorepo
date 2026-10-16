import { assert } from '@hyperlane-xyz/utils';

import {
  PROVISIONAL_MESSAGE_AFFECTED_QUERY,
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
    assert(!selectArgs.offset, 'offset is unsupported with confirmations');
    // Branches retain every column used by outer filters, ordering, or DISTINCT.
    const branchArgs = { ...selectArgs, columns: undefined, offset: undefined };
    const canonicalQuery = buildSelect('message_view', branchArgs, {
      relation: 'canonical_message_view',
      values: [confirmations],
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
      affected_message(msg_id) AS (${PROVISIONAL_MESSAGE_AFFECTED_QUERY}),
      affected_projection AS (
        SELECT projection.*, TRUE AS is_provisional
        FROM (${PROVISIONAL_MESSAGE_PROJECTION_QUERY}) projection
      ),
      canonical_message_view AS (
        SELECT canonical.*, FALSE AS is_provisional FROM message_view canonical
        WHERE NOT EXISTS (SELECT 1 FROM affected_message affected
          WHERE affected.msg_id=canonical.msg_id)
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
