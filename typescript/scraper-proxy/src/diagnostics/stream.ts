import { NotificationWorker } from '../live/notification-worker.js';
import { SNAPSHOT_BATCH_SIZE, type DiagnosticsService } from './service.js';
import { DiagnosticsEventType, type DiagnosticsFrame } from './types.js';

const MAX_DIAGNOSTICS_IDS = 200;
const MAX_DIAGNOSTICS_IDS_PER_IP = 50;
const NOTIFICATION_BATCH_MS = 25;
const RETRY_MS = 1_000;

type Subscriber = {
  ip: string;
  ids: string[];
  // True means accepted for sending; completion reports delivery.
  send: (frame: DiagnosticsFrame, complete: (sent: boolean) => void) => boolean;
  // null marks an unavailable snapshot; absence means not sent yet.
  previous: Map<string, string | null>;
  inFlight: Map<string, string | null>;
};
type SnapshotFrame = Extract<
  DiagnosticsFrame,
  { type: DiagnosticsEventType.Snapshot }
>;
type SnapshotPublication = {
  id: string;
  subscriber: Subscriber;
  frame: SnapshotFrame;
  fingerprint: string;
};

/** PostgreSQL notifications are wakeups, not the data source. Initial and
 * reconnect reads repair gaps; normal reads contain only affected watched IDs.
 */
export class DiagnosticsStream {
  private readonly subscribers = new Set<Subscriber>();
  private readonly pending = new Set<string>();
  private readonly updates: NotificationWorker;
  private fanoutStart?: Pick<SnapshotPublication, 'id' | 'subscriber'>;
  private reconnectTimer?: NodeJS.Timeout;
  private connecting?: Promise<void>;
  private listenerAttempt = 0;
  private running?: Promise<void>;
  private stopListening?: () => Promise<void>;
  private started = false;
  private stopped = false;

  constructor(
    private readonly service: DiagnosticsService,
    batchMs = NOTIFICATION_BATCH_MS,
    private readonly retryMs = RETRY_MS,
  ) {
    this.updates = new NotificationWorker(
      batchMs,
      () => this.trackDrain(),
      () => this.scheduleRetry(),
    );
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.connectListener();
  }

  subscribe(ip: string, ids: string[], send: Subscriber['send']): () => void {
    if (this.stopped) throw new Error('Diagnostics stream stopped');
    const ipIds = new Set(
      [...this.subscribers]
        .filter((s) => s.ip === ip)
        .flatMap((s) => s.ids)
        .concat(ids),
    );
    if (ipIds.size > MAX_DIAGNOSTICS_IDS_PER_IP)
      throw new Error('Diagnostics subscription per-IP capacity exceeded');
    const allIds = new Set(
      [...this.subscribers].flatMap((s) => s.ids).concat(ids),
    );
    if (allIds.size > MAX_DIAGNOSTICS_IDS)
      throw new Error('Diagnostics subscription capacity exceeded');
    const subscriber: Subscriber = {
      ip,
      ids,
      send,
      previous: new Map(),
      inFlight: new Map(),
    };
    this.subscribers.add(subscriber);
    this.enqueue(ids, 0);
    return () => this.subscribers.delete(subscriber);
  }

  /** Drain queued wakeups immediately. */
  flush(): Promise<void> {
    return this.updates.flush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.updates.stop();
    clearTimeout(this.reconnectTimer);
    await this.connecting;
    await this.stopListening?.();
    await this.running;
    this.subscribers.clear();
    this.pending.clear();
  }

  private connectListener(): void {
    if (
      this.stopped ||
      !this.service.listen ||
      this.connecting ||
      this.stopListening
    )
      return;
    const attempt = ++this.listenerAttempt;
    const connecting = this.service
      .listen(
        (payload) => {
          if (attempt === this.listenerAttempt) this.notify(payload);
        },
        () => this.disconnected(attempt),
      )
      .then(async (stop) => {
        if (this.stopped || attempt !== this.listenerAttempt) await stop();
        else {
          this.stopListening = stop;
          this.enqueue(this.watchedIds(), 0);
        }
      })
      .catch(() => {
        if (!this.stopped && attempt === this.listenerAttempt) {
          this.unavailable(this.watchedIds());
        }
      })
      .finally(() => {
        if (this.connecting === connecting) this.connecting = undefined;
        if (!this.stopListening) this.scheduleReconnect();
      });
    this.connecting = connecting;
  }

  private disconnected(attempt: number): void {
    if (this.stopped || attempt !== this.listenerAttempt) return;
    this.listenerAttempt++;
    const stop = this.stopListening;
    this.stopListening = undefined;
    void stop?.().catch(() => undefined);
    this.unavailable(this.watchedIds());
    if (!this.connecting) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || !this.service.listen) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectListener();
    }, this.retryMs).unref();
  }

  private notify(payload: string): void {
    if (!/^[0-9a-f]{64}$/i.test(payload)) return;
    this.enqueue([`0x${payload.toLowerCase()}`]);
  }

  private watchedIds(): string[] {
    return [...new Set([...this.subscribers].flatMap(({ ids }) => ids))];
  }

  private watched(id: string): boolean {
    return [...this.subscribers].some(({ ids }) => ids.includes(id));
  }

  private enqueue(ids: string[], delay = NOTIFICATION_BATCH_MS): void {
    for (const id of ids) if (this.watched(id)) this.pending.add(id);
    if (this.pending.size) this.updates.schedule(delay);
  }

  private scheduleRetry(): void {
    if (this.pending.size) this.updates.schedule(this.retryMs);
  }

  private trackDrain(): Promise<void> {
    const running = this.drain();
    this.running = running;
    return running.finally(() => {
      if (this.running === running) this.running = undefined;
    });
  }

  private async drain(): Promise<void> {
    const queued = [...this.pending].filter((id) => this.watched(id));
    this.pending.clear();
    const snapshots: SnapshotFrame['data'][] = [];
    for (
      let offset = 0;
      offset < queued.length && !this.stopped;
      offset += SNAPSHOT_BATCH_SIZE
    ) {
      const batch = queued.slice(offset, offset + SNAPSHOT_BATCH_SIZE);
      try {
        snapshots.push(...(await this.service.snapshots(batch)));
      } catch {
        this.unavailable(batch);
        this.enqueue(queued.slice(offset), this.retryMs);
        break;
      }
    }
    this.publish(snapshots);
  }

  private publish(snapshots: SnapshotFrame['data'][]): void {
    const publications = snapshots.flatMap((data) => {
      const id = data.message_id;
      const fingerprint = JSON.stringify(data);
      const frame: SnapshotFrame = {
        type: DiagnosticsEventType.Snapshot,
        data,
      };
      return [...this.subscribers]
        .filter((subscriber) => {
          const pending = subscriber.inFlight.get(id);
          return (
            subscriber.ids.includes(id) &&
            pending !== fingerprint &&
            (subscriber.previous.get(id) !== fingerprint || pending === null)
          );
        })
        .map((subscriber) => ({ id, subscriber, frame, fingerprint }));
    });
    const resume = this.fanoutStart;
    const resumeIndex = resume
      ? publications.findIndex(
          ({ id, subscriber }) =>
            id === resume.id && subscriber === resume.subscriber,
        )
      : -1;
    if (resumeIndex > 0)
      publications.push(...publications.splice(0, resumeIndex));
    let retryStart = publications[1] ?? publications[0];
    let retrying = false;
    const setRetryStart = () => {
      if (retryStart)
        this.fanoutStart = {
          id: retryStart.id,
          subscriber: retryStart.subscriber,
        };
    };
    this.fanoutStart = undefined;
    for (const [index, publication] of publications.entries()) {
      const { id, subscriber, frame, fingerprint } = publication;
      subscriber.inFlight.set(id, fingerprint);
      const accepted = subscriber.send(frame, (sent) => {
        if (subscriber.inFlight.get(id) !== fingerprint) return;
        subscriber.inFlight.delete(id);
        if (sent) subscriber.previous.set(id, fingerprint);
        else if (this.subscribers.has(subscriber)) {
          retrying = true;
          setRetryStart();
          this.enqueue([id], this.retryMs);
        }
      });
      if (accepted) {
        retryStart = publications[(index + 1) % publications.length];
        if (retrying) setRetryStart();
      }
    }
  }

  private unavailable(ids: string[]): void {
    for (const subscriber of this.subscribers) {
      const failed = subscriber.ids.filter(
        (id) =>
          ids.includes(id) &&
          subscriber.previous.get(id) !== null &&
          !subscriber.inFlight.has(id),
      );
      if (!failed.length) continue;
      for (const id of failed) subscriber.inFlight.set(id, null);
      subscriber.send(
        {
          type: DiagnosticsEventType.Unavailable,
          message_ids: failed,
          message: 'Diagnostics temporarily unavailable; retrying',
        },
        (sent) => {
          for (const id of failed) {
            if (subscriber.inFlight.get(id) !== null) continue;
            subscriber.inFlight.delete(id);
            if (sent) subscriber.previous.set(id, null);
            else if (this.subscribers.has(subscriber))
              this.enqueue([id], this.retryMs);
          }
        },
      );
    }
  }
}
