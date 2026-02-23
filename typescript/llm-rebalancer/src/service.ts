import type { Logger } from 'pino';

import { SkillFirstLoop } from './loop/SkillFirstLoop.js';

export class LlmRebalancerService {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly loop: SkillFirstLoop,
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.tick();

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.logger.error({ err: error }, 'LLM rebalancer cycle failed');
      });
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    await this.loop.runCycle();
  }
}
