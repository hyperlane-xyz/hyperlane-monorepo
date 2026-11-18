// Per-process source for /messages. A browser owns only a projection cursor.
// Range scans and hydration of the retained range never use subscriber parameters.
import {
  confirmationHeight,
  type ConfirmationHead,
  type Position,
} from './confirmation-stream.js';
import type { EventStore, MessageChange } from './event-store.js';
import { projectMessage, type MessageFacts } from './message-facts.js';
import {
  MAX_EXPLORER_CONFIRMATIONS,
  type HeadNotification,
} from './protocol.js';

const MAX_CHANGES = 50_000;
const MAX_FACT_BYTES = 64 * 1024 * 1024;
const MAX_PARALLEL_DOMAINS = 4;
const FACT_BATCH_SIZE = 64;
const MAX_FACT_QUERIES = 2;
const DOMAIN_RETRY_MS = 30_000;
const END_ID = 9_223_372_036_854_775_807n;

type Head = ConfirmationHead & { hash?: string };
type Window = {
  floor: bigint;
  through: bigint;
  changes: MessageChange[];
  loading?: Promise<void>;
};
type Entry = {
  refs: number;
  bytes: number;
  value?: Promise<MessageFacts | undefined>;
  loading?: Pending;
};
type Pending = {
  started: boolean;
  resolve: (facts?: MessageFacts) => void;
  reject: (error: unknown) => void;
};

export class MessageSource {
  private readonly heads = new Map<number, Head>();
  private snapshot?: Promise<Map<number, Head>>;
  private readonly retryAfter = new Map<number, number>();
  private readonly windows = new Map<number, Window>();
  private readonly entries = new Map<string, Entry>();
  private readonly projections = new WeakMap<
    MessageFacts,
    {
      heights: Map<number, bigint | undefined>;
      row: ReturnType<typeof projectMessage>;
    }
  >();
  private readonly pending = new Map<string, Pending>();
  private scheduled = false;
  private factQueries = 0;
  private changes = 0;
  private bytes = 0;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private stopped = false;

  constructor(
    private readonly store: Pick<
      EventStore,
      'messageHeads' | 'messageChanges' | 'messageFacts'
    >,
  ) {}

  metrics() {
    return {
      ranges: this.windows.size,
      changes: this.changes,
      factBytes: this.bytes,
    };
  }

  // Listen is established before this lazy snapshot. Notifications received
  // while the snapshot is running win, including rollbacks to a lower height.
  currentHeads() {
    this.snapshot ??= this.store
      .messageHeads()
      .then((rows) => {
        for (const [domain, head] of rows)
          if (!this.heads.has(domain)) this.heads.set(domain, head);
        return this.heads;
      })
      .catch((err: unknown) => {
        this.snapshot = undefined;
        this.heads.clear();
        throw err;
      });
    return this.snapshot;
  }

  observe(head: HeadNotification, interested: () => boolean) {
    if (!this.snapshot) return;
    const previous = this.heads.get(head.domain);
    const indexed = head.indexedHeight ?? previous?.indexed;
    const tip = head.headHeight ?? previous?.head;
    if (indexed === undefined || tip === undefined) return;
    const next = {
      head: tip,
      indexed,
      confirmed: head.confirmedHeight,
      hash:
        head.indexedHash ??
        (previous?.indexed === indexed ? previous.hash : undefined),
    };
    this.heads.set(head.domain, next);
    const window = this.windows.get(head.domain);
    const replaced =
      previous?.indexed === indexed &&
      !!previous.hash &&
      !!next.hash &&
      previous.hash !== next.hash;
    if (
      replaced ||
      (head.previousIndexedHeight !== undefined &&
        indexed < head.previousIndexedHeight)
    ) {
      if (window) this.dropWindow(head.domain, window);
      // Cross-domain projections can include a removed delivery/payment even
      // when the retained change is on a different domain.
      for (const entry of this.entries.values()) this.invalidate(entry);
    } else if (window && !window.loading) {
      // Retain unprocessed advances. A stalled domain cannot pin old rows forever.
      const floor = confirmationHeight(next, 2 * MAX_EXPLORER_CONFIRMATIONS);
      if (floor > window.through && !interested()) {
        this.dropWindow(head.domain, window);
        return;
      }
      this.trim(window, floor < window.through ? floor : window.through);
    }
    return replaced;
  }

  invalidateIds(ids: readonly string[]) {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) this.invalidate(entry);
    }
  }

  private invalidate(entry: Entry) {
    // The pending query will see the change if it has not reached PostgreSQL yet.
    if (entry.loading && !entry.loading.started) return;
    this.bytes -= entry.bytes;
    entry.bytes = 0;
    entry.value = undefined;
    entry.loading = undefined;
  }

  private trim(window: Window, floor: bigint) {
    if (floor <= window.floor) return;
    let removed = 0;
    for (const change of window.changes) {
      if (change.position[0] > floor) break;
      const entry = this.entries.get(change.id);
      if (entry) entry.refs--;
      removed++;
    }
    if (removed) window.changes = window.changes.slice(removed);
    this.changes -= removed;
    window.floor = floor;
  }

  private dropWindow(domain: number, window: Window) {
    if (this.windows.get(domain) !== window) return;
    this.windows.delete(domain);
    this.trim(window, END_ID);
  }

  private entry(id: string) {
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= MAX_CHANGES) {
        this.evictIdle();
        if (this.entries.size >= MAX_CHANGES)
          throw new Error('Message source ID limit exceeded');
      }
      entry = { refs: 0, bytes: 0 };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private evictIdle() {
    for (const [id, entry] of this.entries) {
      if (entry.refs || entry.loading) continue;
      this.invalidate(entry);
      this.entries.delete(id);
    }
  }

  private facts(id: string) {
    const entry = this.entry(id);
    if (!entry.value) {
      entry.value = new Promise<MessageFacts | undefined>((resolve, reject) => {
        const request = { resolve, reject, started: false };
        entry.loading = request;
        this.pending.set(id, request);
      });
      this.scheduleFacts();
    }
    return entry.value;
  }

  private scheduleFacts() {
    if (
      this.scheduled ||
      !this.pending.size ||
      this.factQueries >= MAX_FACT_QUERIES
    )
      return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      while (this.pending.size && this.factQueries < MAX_FACT_QUERIES) {
        const batch = new Map<string, Pending>();
        for (const [id, request] of this.pending) {
          this.pending.delete(id);
          request.started = true;
          batch.set(id, request);
          if (batch.size === FACT_BATCH_SIZE) break;
        }
        this.factQueries++;
        void this.fetchFacts(batch).finally(() => {
          this.factQueries--;
          this.scheduleFacts();
        });
      }
    });
  }

  private async fetchFacts(batch: Map<string, Pending>) {
    try {
      if (this.stopped) throw new Error('Message source stopped');
      const result = await this.store.messageFacts([...batch.keys()]);
      const bytes = [...result.values()].reduce(
        (sum, facts) => sum + facts.bytes,
        0,
      );
      if (this.bytes + bytes > MAX_FACT_BYTES) {
        this.evictIdle();
        if (this.bytes + bytes > MAX_FACT_BYTES)
          throw new Error('Message source byte limit exceeded');
      }
      for (const [id, request] of batch) {
        const facts = result.get(id);
        const entry = this.entries.get(id);
        if (entry && entry.loading === request) {
          entry.loading = undefined;
          entry.bytes = facts?.bytes ?? 0;
          this.bytes += entry.bytes;
        }
        request.resolve(facts);
      }
    } catch (err) {
      for (const [id, request] of batch) {
        const entry = this.entries.get(id);
        if (entry && entry.loading === request) this.invalidate(entry);
        request.reject(err);
      }
    }
  }

  private async extend(domain: number, window: Window, through: bigint) {
    if (this.running >= MAX_PARALLEL_DOMAINS)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running++;
    try {
      if (this.stopped || this.windows.get(domain) !== window) return;
      for await (const page of this.store.messageChanges(
        domain,
        [window.through, 3, END_ID],
        through,
      )) {
        if (this.stopped || this.windows.get(domain) !== window) return;
        if (this.changes + page.length > MAX_CHANGES)
          throw new Error('Message source range limit exceeded');
        const ids = new Set<string>();
        for (const change of page) {
          this.entry(change.id).refs++;
          window.changes.push(change);
          this.changes++;
          ids.add(change.id);
        }
        const changed = [...ids];
        this.invalidateIds(changed);
        await Promise.all(changed.map((id) => this.facts(id)));
      }
      window.through = through;
    } catch (err) {
      if (this.windows.get(domain) === window)
        this.retryAfter.set(domain, Date.now() + DOMAIN_RETRY_MS);
      this.dropWindow(domain, window);
      throw err;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }

  async prepare(domain: number, after: bigint, through: bigint) {
    const head = this.heads.get(domain);
    if (!head || this.stopped) return;
    let window = this.windows.get(domain);
    if (!window) {
      if ((this.retryAfter.get(domain) ?? 0) > Date.now())
        throw new Error('Message range temporarily unavailable');
      this.retryAfter.delete(domain);
      const oldest = confirmationHeight(head, MAX_EXPLORER_CONFIRMATIONS);
      const floor = oldest < after ? oldest : after;
      window = { floor, through: floor, changes: [] };
      this.windows.set(domain, window);
    }
    while (window.through < through) {
      if (this.stopped || this.windows.get(domain) !== window) return;
      window.loading ??= this.extend(domain, window, through).finally(() => {
        window.loading = undefined;
      });
      await window.loading;
    }
  }

  async *read(
    domain: number,
    after: Position,
    through: bigint,
    frontiers: Map<number, bigint>,
    confirmations: number,
    ids?: Set<string>,
  ) {
    if (ids?.size === 0) return;
    // Rollbacks are delivered immediately and can also advance a lagging cursor.
    await this.prepare(domain, after[0], through);
    const window = this.windows.get(domain);
    if (!window || this.stopped) return;
    if (after[0] < window.floor)
      throw new Error('Message subscription fell behind the retained range');
    // A slow socket must neither retain evicted pages nor skip newly-trimmed rows.
    let floor = window.floor;
    let cursor = after;
    let i = firstAfter(window.changes, cursor);
    while (i < window.changes.length || floor !== window.floor) {
      if (this.stopped || this.windows.get(domain) !== window) return;
      if (floor !== window.floor) {
        if (cursor[0] < window.floor)
          throw new Error(
            'Message subscription fell behind the retained range',
          );
        floor = window.floor;
        i = firstAfter(window.changes, cursor);
      }
      const change = window.changes[i++];
      if (!change || change.position[0] > through) return;
      cursor = change.position;
      if (ids && !ids.has(change.id)) continue;
      const facts = await this.facts(change.id);
      const projection = facts && this.project(facts, frontiers);
      yield {
        position: change.position,
        domains: projection?.domains,
        message: projection && {
          type: 'message_upsert',
          confirmations,
          domain,
          height: String(through),
          data: projection.data,
        },
      };
    }
  }

  async enrich(ids: string[], frontiers: Map<number, bigint>) {
    const facts = await Promise.all(ids.map((id) => this.facts(id)));
    return facts.flatMap((f) => {
      const row = f && this.project(f, frontiers);
      return row ? [row] : [];
    });
  }

  private project(facts: MessageFacts, frontiers: Map<number, bigint>) {
    const frontier = (domain: number) =>
      frontiers.get(domain) ?? this.heads.get(domain)?.confirmed;
    const previous = this.projections.get(facts);
    if (previous) {
      let current = true;
      for (const [domain, height] of previous.heights) {
        if (frontier(domain) !== height) {
          current = false;
          break;
        }
      }
      if (current) return previous.row;
    }
    const heights = new Map(
      [...facts.dependencies].map((domain) => [domain, frontier(domain)]),
    );
    const row = projectMessage(facts, frontier);
    this.projections.set(facts, { heights, row });
    return row;
  }

  stop() {
    this.stopped = true;
    for (const [domain, window] of this.windows)
      this.dropWindow(domain, window);
    for (const entry of this.entries.values()) this.invalidate(entry);
    this.entries.clear();
  }
}

function firstAfter(changes: MessageChange[], position: Position): number {
  let lo = 0,
    hi = changes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const [height, source, id] = changes[mid].position;
    if (
      height < position[0] ||
      (height === position[0] &&
        (source < position[1] || (source === position[1] && id <= position[2])))
    )
      lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
