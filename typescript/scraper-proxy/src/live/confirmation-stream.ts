import type { HeadNotification, LiveStartBoundary } from './protocol.js';

// Height, source, row ID. Source distinguishes Explorer's three event tables.
export type Position = readonly [bigint, number, bigint];
export type ConfirmationRow = {
  position: Position;
  message: Record<string, unknown>;
};
export type ConfirmationHead = {
  head: bigint;
  indexed: bigint;
  confirmed: bigint;
  liveStart?: LiveStartBoundary;
};
export class ConfirmationUnavailableError extends Error {
  constructor(domain: number) {
    super(`Custom confirmations unavailable for domain ${domain}`);
  }
}
type DomainState = {
  liveStart?: LiveStartBoundary;
  position: Position;
  target: bigint;
  through: bigint;
};
const END_OF_HEIGHT = 9_223_372_036_854_775_807n;

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
  constructor(
    readonly confirmations: number,
    readonly domains: Set<number>,
    private readonly io: {
      active: () => boolean;
      read: (
        domain: number,
        after: Position,
        through: bigint,
      ) => AsyncIterable<ConfirmationRow>;
      send: (message: Record<string, unknown>) => Promise<boolean>;
      rollback: (domain: number, from: bigint, to: bigint) => void;
      fail: (error: unknown) => void;
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
        const target = confirmationHeight(head, this.confirmations);
        const height = head.liveStart ? BigInt(head.liveStart.height) : target;
        this.states.set(domain, {
          position: endOfHeight(height),
          target,
          liveStart: head.liveStart,
          through: height,
        });
      }
      return;
    }
  }

  liveStart(domain: number): LiveStartBoundary | undefined {
    return this.states.get(domain)?.liveStart;
  }

  get canonicalDomains(): number[] {
    return [...this.domains].filter((domain) => !this.states.has(domain));
  }

  start(): void {
    this.started = true;
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
    if (rollback) {
      this.revision++;
      // Never authorize handoff using a snapshot from before a rollback.
      state.liveStart = undefined;
      // through is reserved BEFORE reading/sending a range. It covers partial
      // pages, events without a public height, and pending send callbacks.
      const exposedRollback = this.started && state.through > to;
      if (exposedRollback) {
        this.io.rollback(head.domain, state.through, to);
      }
      state.through = to;
      if (state.position[0] > to) state.position = endOfHeight(to);
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
        if ([...this.states.values()].some(needsRead)) this.schedule();
      });
  }

  private async drain(): Promise<void> {
    while (this.io.active()) {
      const next = [...this.states].find(([, state]) => needsRead(state));
      if (!next) return;
      const [domain, state] = next;
      const through = state.target;
      const revision = this.revision;
      if (through > state.through) state.through = through;
      for await (const row of this.io.read(domain, state.position, through)) {
        if (!this.io.active()) return;
        if (revision !== this.revision) break;
        state.position = row.position;
        if (!(await this.io.send(row.message))) {
          this.started = false;
          return;
        }
      }
      if (revision === this.revision) state.position = endOfHeight(through);
    }
  }
}

export function endOfHeight(height: bigint): Position {
  return [height, 3, END_OF_HEIGHT];
}

function needsRead(state: DomainState): boolean {
  return (
    state.target > state.position[0] ||
    (state.target === state.position[0] && state.position[1] < 3)
  );
}
