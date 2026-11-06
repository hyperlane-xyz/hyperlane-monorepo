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
const columns = `id::text, '0x' || encode(message_id, 'hex') AS message_id,
  '0x' || encode(relayer, 'hex') AS relayer, origin, destination,
  observed_at::text, received_at::text, version, activity`;

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
         (SELECT DISTINCT ON (relayer, activity->>'type') ${columns}
          FROM public.message_activity AS current_activity
          WHERE message_id = decode(requested.message_hex, 'hex')
            AND activity->>'type' IN ('snapshot', 'snapshot_update')
            AND id >= (
              SELECT max(anchor.id) FROM public.message_activity AS anchor
              WHERE anchor.message_id = current_activity.message_id
                AND anchor.relayer = current_activity.relayer
                AND anchor.activity->>'type' = 'snapshot'
            )
          ORDER BY relayer, activity->>'type', id DESC)
         UNION
         (SELECT ${columns} FROM public.message_activity
          WHERE message_id = decode(requested.message_hex, 'hex')
            AND NOT EXISTS (
              SELECT 1 FROM public.message_activity AS snapshot
              WHERE snapshot.message_id = message_activity.message_id
                AND snapshot.relayer = message_activity.relayer
                AND snapshot.activity->>'type' = 'snapshot'
            )
          ORDER BY message_activity.id DESC LIMIT $2)
       ) activity ORDER BY activity.message_id, activity.id::bigint DESC`,
      [normalized.map((id) => id.slice(2)), SNAPSHOT_LIMIT + 1],
    );
    return normalized.map((id) => {
      const matching = rows.filter((row) => row.message_id === id);
      const activities = matching.slice(0, SNAPSHOT_LIMIT).reverse();
      return {
        version: 1,
        message_id: id,
        partial: matching.length > SNAPSHOT_LIMIT,
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
