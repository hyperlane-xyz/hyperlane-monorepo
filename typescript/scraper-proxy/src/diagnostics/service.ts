import { rootLogger } from '@hyperlane-xyz/utils';
import { GraphQLError } from 'graphql';
import pg from 'pg';

import { displayAddress, parseMessageId } from '../live/protocol.js';
import type { ScraperDbDatabase } from '../scraperdb/database.js';
import type { MessageDiagnostics } from './types.js';
import { activityRow, reduceStatus, type ActivityRow } from './status.js';

const SNAPSHOT_LIMIT = 100;
export const SNAPSHOT_BATCH_SIZE = 20;
export const MESSAGE_ACTIVITY_CHANNEL = 'message_activity_insert';
const LISTENER_HEALTH_MS = 30_000;
const MAX_HISTORY_LIMIT = 500;
const logger = rootLogger.child({ module: 'Diagnostics' });
function activityColumns(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}id::text, '0x' || encode(${prefix}message_id, 'hex') AS message_id,
    '0x' || encode(${prefix}relayer, 'hex') AS relayer, ${prefix}origin, ${prefix}destination,
    ${prefix}observed_at::text, ${prefix}received_at::text, ${prefix}version, ${prefix}activity`;
}
const columns = activityColumns();
const currentColumns = activityColumns('current_activity');

/** Keep each selected reporter's snapshot baseline within the row budget. */
function snapshotActivities(rows: ActivityRow[]): ActivityRow[] {
  const snapshots = new Map<
    string,
    { anchor?: ActivityRow; update?: ActivityRow }
  >();
  const newest = new Map<string, ActivityRow>();
  for (const row of rows) {
    if (!newest.has(row.relayer)) newest.set(row.relayer, row);
    const type = row.activity.type;
    if (type !== 'snapshot' && type !== 'snapshot_update') continue;
    const state = snapshots.get(row.relayer) ?? {};
    if (type === 'snapshot' && !state.anchor) state.anchor = row;
    if (type === 'snapshot_update' && !state.update) state.update = row;
    snapshots.set(row.relayer, state);
  }
  const selected = new Map<string, ActivityRow>();
  for (const row of rows) {
    const state = snapshots.get(row.relayer);
    if (row.activity.type === 'snapshot_update' && !state?.anchor) continue;
    const group = new Map<string, ActivityRow>();
    for (const item of [
      row,
      state?.anchor,
      state?.anchor ? state.update : undefined,
      state?.anchor ? newest.get(row.relayer) : undefined,
    ]) {
      if (item && !selected.has(item.id)) group.set(item.id, item);
    }
    if (selected.size + group.size > SNAPSHOT_LIMIT) continue;
    for (const [id, item] of group) selected.set(id, item);
  }
  return [...selected.values()].sort((a, b) => {
    const left = BigInt(a.id);
    const right = BigInt(b.id);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export class DiagnosticsService {
  constructor(
    private readonly db: ScraperDbDatabase,
    readonly listen?: (
      notify: (payload: string) => void,
      disconnect: () => void,
    ) => Promise<() => Promise<void>>,
  ) {}

  async history(id: string, before?: string | null, limit = 100) {
    const normalized = displayAddress(parseMessageId(id));
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT)
      throw new GraphQLError(
        `limit must be between 1 and ${MAX_HISTORY_LIMIT}`,
      );
    if (
      before != null &&
      (!/^\d+$/.test(before) || BigInt(before) > 9223372036854775807n)
    )
      throw new GraphQLError('before_id must be a non-negative bigint string');
    const rows = await this.read(
      `SELECT ${columns} FROM public.message_activity
       WHERE message_id = decode($1, 'hex') AND ($3::bigint IS NULL OR id < $3::bigint)
       ORDER BY message_activity.id DESC LIMIT $2`,
      [normalized.slice(2), limit + 1, before ?? null],
    );
    const activities = rows.slice(0, limit);
    return {
      message_id: normalized,
      activities,
      has_more: rows.length > limit,
      next_before_id: rows.length > limit ? activities.at(-1)?.id : null,
    };
  }

  async snapshots(ids: string[]): Promise<MessageDiagnostics[]> {
    if (!ids.length || ids.length > SNAPSHOT_BATCH_SIZE)
      throw new Error(`Expected 1–${SNAPSHOT_BATCH_SIZE} message IDs`);
    const normalized = [
      ...new Set(ids.map((id) => displayAddress(parseMessageId(id)))),
    ];
    const rows = await this.read(
      `SELECT activity.* FROM unnest($1::text[]) AS requested(message_hex)
       CROSS JOIN LATERAL (
         WITH anchors AS MATERIALIZED (
           SELECT relayer, max(id) AS anchor_id FROM public.message_activity
           WHERE message_id = decode(requested.message_hex, 'hex')
             AND activity->>'type' = 'snapshot'
           GROUP BY relayer
         ), states AS MATERIALIZED (
           SELECT anchors.*, coalesce(latest_update.id, anchors.anchor_id) AS state_id
           FROM anchors LEFT JOIN LATERAL (
             SELECT current_activity.id FROM public.message_activity AS current_activity
             WHERE current_activity.message_id = decode(requested.message_hex, 'hex')
               AND current_activity.relayer = anchors.relayer
               AND current_activity.id > anchors.anchor_id
               AND current_activity.activity->>'type' = 'snapshot_update'
             ORDER BY current_activity.id DESC LIMIT 1
           ) latest_update ON true
         )
         SELECT ${currentColumns} FROM public.message_activity AS current_activity
         JOIN states ON current_activity.id = states.anchor_id
         UNION ALL
         SELECT ${currentColumns} FROM public.message_activity AS current_activity
         JOIN states ON current_activity.id = states.state_id
         WHERE states.state_id > states.anchor_id
         UNION ALL
         (SELECT ${currentColumns} FROM public.message_activity AS current_activity
          LEFT JOIN states ON states.relayer = current_activity.relayer
          WHERE current_activity.message_id = decode(requested.message_hex, 'hex')
            AND (states.relayer IS NULL OR current_activity.id > states.state_id)
          ORDER BY current_activity.id DESC LIMIT $2)
       ) activity ORDER BY activity.message_id, activity.id::bigint DESC`,
      [normalized.map((id) => id.slice(2)), SNAPSHOT_LIMIT + 1],
    );
    return normalized.map((id) => {
      const matching = rows.filter((row) => row.message_id === id);
      const activities = snapshotActivities(matching);
      return {
        version: 1,
        message_id: id,
        partial: matching.length > activities.length,
        activities,
        relayers: reduceStatus(activities),
      };
    });
  }

  private async read(sql: string, values: unknown[]): Promise<ActivityRow[]> {
    try {
      return (await this.db.query(sql, values)).map((row) =>
        activityRow.parse(row),
      );
    } catch {
      // DB errors can contain connection details; neither responses nor logs expose them.
      logger.warn('Diagnostics database read failed');
      throw new GraphQLError('Diagnostics temporarily unavailable', {
        extensions: { code: 'DIAGNOSTICS_UNAVAILABLE' },
      });
    }
  }
}

export function openDiagnostics(url: string) {
  const connection = {
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 4_000,
    options: '-c default_transaction_read_only=on',
  };
  const pool = new pg.Pool({ ...connection, max: 3 });
  pool.on('error', () => logger.warn('Diagnostics database connection failed'));
  const service = new DiagnosticsService(
    {
      query: async (sql, values) =>
        (await pool.query<Record<string, unknown>>(sql, values)).rows,
    },
    async (notify, disconnect) => {
      const client = new pg.Client(connection);
      let healthTimer: NodeJS.Timeout | undefined;
      let closed = false;
      let disconnected = false;
      const onDisconnect = () => {
        if (closed || disconnected) return;
        disconnected = true;
        disconnect();
      };
      client.on('error', onDisconnect);
      client.on('end', onDisconnect);
      client.on('notification', ({ channel, payload }) => {
        if (channel === MESSAGE_ACTIVITY_CHANNEL && payload) notify(payload);
      });
      try {
        await client.connect();
        await client.query(`LISTEN ${MESSAGE_ACTIVITY_CHANNEL}`);
        healthTimer = setInterval(() => {
          void client.query('SELECT 1').catch(onDisconnect);
        }, LISTENER_HEALTH_MS).unref();
      } catch (error) {
        closed = true;
        await client.end().catch(() => undefined);
        throw error;
      }
      return async () => {
        closed = true;
        clearInterval(healthTimer);
        await client.end().catch(() => undefined);
      };
    },
  );
  return { service, close: () => pool.end() };
}
