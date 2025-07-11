import type { Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';

export class RegistryService {
  private registry: IRegistry | null = null;
  private lastRefresh: number = Date.now();
  private refreshPromise: Promise<IRegistry> | null = null;

  constructor(
    private readonly getRegistry: () => Promise<IRegistry>,
    private readonly refreshInterval: number,
    private readonly logger: Logger,
  ) {}

  async initialize() {
    this.registry = await this.getRegistry();
  }

  async getCurrentRegistry(): Promise<IRegistry> {
    const now = Date.now();
    if (now - this.lastRefresh > this.refreshInterval || !this.registry) {
      if (this.refreshPromise) {
        return this.refreshPromise;
      }

      this.logger.info('Refreshing registry cache...');
      this.refreshPromise = this.getRegistry();
      try {
        this.registry = await this.refreshPromise;
        this.lastRefresh = now;
      } finally {
        this.refreshPromise = null;
      }
    }

    return this.registry;
  }

  async withRegistry<T>(
    operation: (registry: IRegistry) => Promise<T>,
  ): Promise<T> {
    const registry = await this.getCurrentRegistry();
    return operation(registry);
  }
}
