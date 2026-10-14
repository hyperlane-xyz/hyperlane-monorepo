import type { HeadNotification } from './protocol.js';

// Height, source, row ID. Source distinguishes Explorer's three event tables.
export type Position = readonly [bigint, number, bigint];
export type ConfirmationRow = {
  domains?: readonly number[];
  position: Position;
  message?: Record<string, unknown>;
};
type EnrichedMessage = {
  domains?: readonly number[];
  message: Record<string, unknown>;
};
export type ConfirmationHead = {
  head: bigint;
  indexed: bigint;
  confirmed: bigint;
};
export class ConfirmationUnavailableError extends Error {
  constructor(domain: number) {
    super(`Custom confirmations unavailable for domain ${domain}`);
  }
}
type DomainState = {
  position: Position;
  target: bigint;
  through: bigint;
};
const END_OF_HEIGHT = 9_223_372_036_854_775_807n;
const MAX_CUSTOM_MESSAGE_IDS = 10_000;

export function confirmationHeight(
  head: Pick<ConfirmationHead, 'head' | 'indexed'>,
  confirmations: number,
): bigint {
  const height = head.head - BigInt(confirmations);
  return height < head.indexed ? height : head.indexed;
}

/** One paginated reader, with no live-event queue or separate catch-up path. */
export class ConfirmationStream {
  private readonly states = new Map<number, DomainState>();
  private revision = 0;
  private running = false;
  private started = false;
  private readonly refreshIds = new Set<string>();
  private readonly exposedIds = new Map<string, Map<number, bigint>>();
  private readonly confirmed = new Map<number, bigint>();

  constructor(
    readonly confirmations: number,
    readonly domains: Set<number>,
    private readonly io: {
      active: () => boolean;
      read: (
        domain: number,
        after: Position,
        through: bigint,
        frontiers: Map<number, bigint>,
      ) => AsyncIterable<ConfirmationRow>;
      send: (message: Record<string, unknown>) => Promise<boolean>;
      rollback: (domain: number, from: bigint, to: bigint) => void;
      fail: (error: unknown) => void;
      messageId?: (message: Record<string, unknown>) => string | undefined;
      enrich?: (
        ids: string[],
        frontiers: Map<number, bigint>,
      ) => Promise<EnrichedMessage[]>;
    },
  ) {}

  async initialize(
    readHeads: () => Promise<Map<number, ConfirmationHead>>,
    allowCanonical = false,
  ): Promise<void> {
    // Notifications can arrive during negotiation. Retry the snapshot, before
    // sending ready/subscribed, if its ancestry may already have changed.
    while (this.io.active()) {
      const revision = this.revision;
      const heads = await readHeads();
      if (revision !== this.revision) continue;
      for (const domain of this.domains) {
        const head = heads.get(domain);
        if (!head) {
          if (allowCanonical) continue;
          throw new ConfirmationUnavailableError(domain);
        }
        const height = confirmationHeight(head, this.confirmations);
        this.confirmed.set(domain, head.confirmed);
        this.states.set(domain, {
          position: endOfHeight(height),
          target: height,
          through: height,
        });
      }
      return;
    }
  }

  get customDomains(): number[] {
    return [...this.states.keys()];
  }

  get canonicalDomains(): number[] {
    return [...this.domains].filter((domain) => !this.states.has(domain));
  }

  start(): void {
    this.started = true;
    this.schedule();
  }

  refresh(ids: string[]): void {
    if (!this.io.enrich) return;
    ids.forEach((id) => this.refreshIds.add(id));
    if (this.refreshIds.size > MAX_CUSTOM_MESSAGE_IDS) {
      this.io.fail(new Error('Custom message notification limit exceeded'));
      return;
    }
    this.schedule();
  }

  notify(head: HeadNotification): void {
    if (
      !this.domains.has(head.domain) ||
      head.headHeight === undefined ||
      head.indexedHeight === undefined
    )
      return;
    const state = this.states.get(head.domain);
    const rollback =
      head.previousIndexedHeight !== undefined &&
      head.indexedHeight < head.previousIndexedHeight;
    if (!state) {
      // Capabilities are fixed until reconnect. During negotiation, retry the
      // snapshot only if ancestry changed; afterwards this domain stays canonical.
      if (!this.started && rollback) this.revision++;
      return;
    }
    const to = confirmationHeight(
      { head: head.headHeight, indexed: head.indexedHeight },
      this.confirmations,
    );
    state.target = to;
    this.confirmed.set(head.domain, head.confirmedHeight);
    for (const [id, frontiers] of this.exposedIds) {
      if (this.isCanonical(frontiers)) this.exposedIds.delete(id);
    }
    if (rollback) {
      this.revision++;
      // through is reserved BEFORE reading/sending a range. It covers partial
      // pages, events without a public height, and pending send callbacks.
      const exposedRollback = this.started && state.through > to;
      if (exposedRollback) {
        this.io.rollback(head.domain, state.through, to);
      }
      state.through = to;
      if (state.position[0] > to) state.position = endOfHeight(to);
      // Explorer clears its entire provisional overlay on any rollback.
      if (exposedRollback) this.refresh([...this.exposedIds.keys()]);
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.started || this.running || !this.io.active()) return;
    this.running = true;
    void this.drain()
      .catch((error) => {
        this.started = false;
        this.io.fail(error);
      })
      .finally(() => {
        this.running = false;
        if (this.refreshIds.size || [...this.states.values()].some(needsRead))
          this.schedule();
      });
  }

  private isCanonical(frontiers: Map<number, bigint>): boolean {
    for (const [domain, height] of frontiers)
      if (height > (this.confirmed.get(domain) ?? 0n)) return false;
    return true;
  }

  private remember(
    message: Record<string, unknown>,
    frontiers: Map<number, bigint>,
    domains?: readonly number[],
  ): void {
    const id = this.io.messageId?.(message);
    if (!id) return;
    const dependencies = new Map<number, bigint>();
    for (const domain of domains ?? frontiers.keys()) {
      const height = frontiers.get(domain);
      if (height !== undefined) dependencies.set(domain, height);
    }
    if (this.isCanonical(dependencies)) this.exposedIds.delete(id);
    else this.exposedIds.set(id, dependencies);
    if (this.exposedIds.size > MAX_CUSTOM_MESSAGE_IDS)
      this.io.fail(new Error('Custom provisional message limit exceeded'));
  }

  private async drain(): Promise<void> {
    while (this.io.active()) {
      const next = [...this.states].find(([, state]) => needsRead(state));
      if (!next) {
        if (!this.refreshIds.size || !this.io.enrich) return;
        const ids = [...this.refreshIds].slice(0, 100);
        ids.forEach((id) => this.refreshIds.delete(id));
        const revision = this.revision;
        const frontiers = new Map(
          [...this.states].map(([id, state]) => [id, state.position[0]]),
        );
        const messages = await this.io.enrich(ids, frontiers);
        for (const { message, domains } of messages) {
          if (!this.io.active()) return;
          if (revision !== this.revision) break;
          this.remember(message, frontiers, domains);
          if (!(await this.io.send(message))) {
            this.started = false;
            return;
          }
        }
        if (revision !== this.revision)
          ids.forEach((id) => this.refreshIds.add(id));
        continue;
      }
      const [domain, state] = next;
      const through = state.target;
      const revision = this.revision;
      const frontiers = new Map(
        [...this.states].map(([id, value]) => [id, value.position[0]]),
      );
      frontiers.set(domain, through);
      if (through > state.through) state.through = through;
      for await (const row of this.io.read(
        domain,
        state.position,
        through,
        frontiers,
      )) {
        if (!this.io.active()) return;
        if (revision !== this.revision) break;
        state.position = row.position;
        if (row.message) this.remember(row.message, frontiers, row.domains);
        if (row.message && !(await this.io.send(row.message))) {
          this.started = false;
          return;
        }
      }
      if (revision === this.revision) state.position = endOfHeight(through);
    }
  }
}

function endOfHeight(height: bigint): Position {
  return [height, 3, END_OF_HEIGHT];
}

function needsRead(state: DomainState): boolean {
  return (
    state.target > state.position[0] ||
    (state.target === state.position[0] && state.position[1] < 3)
  );
}
