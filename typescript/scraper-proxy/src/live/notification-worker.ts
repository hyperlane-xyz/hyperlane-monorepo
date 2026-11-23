/** Coalesce wakeups and serialize a notification drain, including explicit flushes. */
export class NotificationWorker {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private nextDelay?: number;
  private stopped = false;

  constructor(
    private readonly batchMs: number,
    private readonly drain: () => Promise<void>,
    private readonly fail: (error: unknown) => void,
  ) {}

  schedule(delay = this.batchMs): void {
    if (this.stopped || this.timer) return;
    this.nextDelay = delay;
    if (this.running) return;
    this.timer = setTimeout(() => void this.flush(), delay);
  }

  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) return this.running;
    this.nextDelay = undefined;
    this.running = this.drain()
      .catch(this.fail)
      .finally(() => {
        this.running = undefined;
        if (this.nextDelay !== undefined) this.schedule(this.nextDelay);
      });
    return this.running;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
