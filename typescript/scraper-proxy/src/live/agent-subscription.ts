import { assert } from '@hyperlane-xyz/utils/validation';

import {
  type Row,
  EventStore,
  STREAMS,
  compareRows,
  eventData,
  rowCursor,
  rowCursorKey,
  rowDomain,
  sequenceKey,
} from './event-store.js';
import {
  displayAddress,
  parseId,
  type StreamCursor,
  type StreamRequest,
} from './protocol.js';

export const MAX_PENDING_EVENTS = 5_000;
type CursorPosition = { value?: bigint; legacyMaxId?: bigint };
type ReplayOutcome = 'success' | 'aborted' | 'failure';

/** Canonical event filtering, ordered replay, and the handoff to live delivery. */
export class AgentSubscription {
  state: 'waiting' | 'replaying' | 'live';
  catchUpRows = 0;
  catchUpStartedAt = Date.now();
  private pending: Row[] = [];
  private readonly positions?: Map<string, CursorPosition>;

  constructor(
    readonly request: StreamRequest,
    private readonly store: EventStore,
    private readonly maxCatchUpMs: number,
    private readonly io: {
      active: () => boolean;
      send: (message: Record<string, unknown>) => Promise<boolean>;
      close: (reason: string) => void;
    },
  ) {
    this.state = request.cursors ? 'waiting' : 'live';
    if (request.cursors)
      this.positions = new Map(
        request.cursors.map(({ domain, address }) => [
          sequenceKey(domain, address),
          {},
        ]),
      );
  }

  isActive(): boolean {
    return this.io.active();
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  matchesDomain(domain: number): boolean {
    return !this.request.domains || this.request.domains.has(domain);
  }

  matches(domain: number, cursorKey?: string): boolean {
    return (
      this.request.confirmations === undefined &&
      this.matchesDomain(domain) &&
      (!this.positions ||
        (cursorKey !== undefined && this.positions.has(cursorKey)))
    );
  }

  buffer(row: Row): boolean {
    // Waiting subscriptions will read these events from the database.
    if (this.state === 'waiting') return true;
    return this.pending.push(row) <= MAX_PENDING_EVENTS;
  }

  async replay(): Promise<ReplayOutcome> {
    this.catchUpStartedAt = Date.now();
    this.state = 'replaying';
    for (const cursor of this.request.cursors ?? []) {
      if (!this.io.active() || !(await this.catchUpCursor(cursor)))
        return 'aborted';
    }
    while (this.pending.length) {
      if (!this.io.active()) return 'aborted';
      const pending = this.pending.sort((a, b) =>
        compareRows(this.request.eventType, a, b),
      );
      this.pending = [];
      for (const row of pending) {
        this.assertCatchUpBudget();
        if (!(await this.deliverAndWait(row))) return 'failure';
      }
    }
    this.state = 'live';
    return 'success';
  }

  private async catchUpCursor(cursor: StreamCursor): Promise<boolean> {
    const { eventType } = this.request;
    const position = this.positions?.get(
      sequenceKey(cursor.domain, cursor.address),
    );
    assert(position, 'Missing subscription cursor');
    const gasPayment = cursor.kind === 'gas_payment';
    const label = gasPayment ? 'stream cursor' : 'sequence';
    let after: bigint;
    let last: bigint;
    let legacyMaxId = 0n;
    if (cursor.kind === 'gas_payment') {
      const bounds = await this.store.gasPaymentCursorBounds(cursor);
      last = bounds.lastCursor;
      legacyMaxId = bounds.legacyMaxId;
      after = cursor.afterStreamCursor ?? last;
      if (after > last)
        throw new Error(
          `Cursor ${after} is ahead of current ${eventType} cursor ${last}`,
        );
      position.legacyMaxId = legacyMaxId;
    } else {
      const bounds = await this.store.sequenceBounds(eventType, cursor);
      last = bounds.last;
      if (last < bounds.first) {
        if (cursor.afterSequence !== undefined && cursor.afterSequence !== -1n)
          throw new Error(
            `No ${eventType} history for domain ${cursor.domain} address ${displayAddress(cursor.address)}`,
          );
        position.value = last;
        return this.io.send({
          address: displayAddress(cursor.address),
          domain: cursor.domain,
          eventType,
          sequence: String(last),
          type: 'caught_up',
        });
      }
      after = cursor.afterSequence ?? last;
      if (after > last && !cursor.allowReplay)
        throw new Error(
          `Sequence ${after} is ahead of current ${eventType} sequence ${last}`,
        );
      if (after > last) after = last;
    }
    position.value = after;
    let current = after;
    while (current < last) {
      if (!this.io.active()) return false;
      this.assertCatchUpBudget();
      const legacyPhase = gasPayment && current < legacyMaxId;
      const through = legacyPhase ? legacyMaxId : last;
      const rows =
        cursor.kind === 'sequence'
          ? await this.store.sequenceRows(eventType, cursor, current, through)
          : await this.store.gasPaymentRows(
              cursor,
              current,
              through,
              legacyPhase,
            );
      this.catchUpRows += rows.length;
      this.assertCatchUpBudget();
      if (!rows.length) {
        if (!legacyPhase)
          throw new Error(`Missing ${eventType} ${label} ${current + 1n}`);
        position.value = through;
      }
      for (const row of rows) {
        this.assertCatchUpBudget();
        if (!(await this.deliverAndWait(row)))
          throw new Error(`Gap in ${eventType} ${label} after ${current}`);
      }
      current = position.value;
    }
    if (
      !(await this.io.send({
        address: displayAddress(cursor.address),
        domain: cursor.domain,
        eventType,
        type: 'caught_up',
        ...(gasPayment
          ? {
              legacyMaxStreamCursor: legacyMaxId.toString(),
              streamCursor: String(current),
            }
          : { sequence: String(last) }),
      }))
    )
      throw new Error('Websocket closed during catch-up');
    return true;
  }

  private async deliverAndWait(row: Row): Promise<boolean> {
    const message = this.eventForDelivery(row);
    if (message === false) return false;
    if (message === undefined) return true;
    if (!(await this.io.send(message))) {
      throw new Error('Websocket closed during catch-up');
    }
    return true;
  }

  eventForDelivery(row: Row): Record<string, unknown> | false | undefined {
    const { eventType } = this.request;
    const domain = rowDomain(row, STREAMS[eventType].domain);
    const key = rowCursorKey(eventType, domain, row);
    if (!this.matches(domain, key)) return undefined;
    const cursor = rowCursor(eventType, row);
    const position = key === undefined ? undefined : this.positions?.get(key);
    const legacyMaxStreamCursor = position?.legacyMaxId;
    if (cursor && position) {
      const current = position.value;
      if (current !== undefined) {
        if (cursor.value <= current) return undefined;
        const contiguous =
          eventType !== 'gas_payment' ||
          (legacyMaxStreamCursor !== undefined &&
            cursor.value > legacyMaxStreamCursor);
        if (contiguous && cursor.value !== current + 1n) {
          const label =
            eventType === 'gas_payment' ? 'stream cursor' : 'sequence';
          this.io.close(
            `${eventType} ${label} gap: expected ${current + 1n}, received ${cursor.value}`,
          );
          return false;
        }
        position.value = cursor.value;
      }
    }
    const data = eventData(eventType, row);
    const rowId =
      eventType === 'gas_payment' ? parseId(row.id).toString() : undefined;
    return {
      data,
      domain,
      eventType,
      legacyMaxStreamCursor: legacyMaxStreamCursor?.toString(),
      rowId,
      streamCursor:
        eventType === 'gas_payment' ? cursor?.value.toString() : undefined,
      sequence:
        eventType !== 'gas_payment' ? cursor?.value.toString() : undefined,
      type: 'event',
    };
  }

  private assertCatchUpBudget(): void {
    if (Date.now() - this.catchUpStartedAt > this.maxCatchUpMs) {
      throw new Error(
        `Historical streaming time limit exceeded (${this.maxCatchUpMs}ms)`,
      );
    }
  }
}
