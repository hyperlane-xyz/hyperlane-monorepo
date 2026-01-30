import { FSWatcher, watch } from 'fs';
import type { Logger } from 'pino';

import {
  IRegistry,
  MergedRegistry,
  RegistryType,
} from '@hyperlane-xyz/registry';

export class RegistryService {
  private registry: IRegistry | null = null;
  private lastRefresh: number = Date.now();
  private refreshPromise: Promise<IRegistry> | null = null;
  private watcher: FSWatcher | null = null;
  private isDirty = false;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly getRegistry: () => Promise<IRegistry>,
    private readonly refreshInterval: number,
    private readonly logger: Logger,
  ) {}

  async initialize() {
    this.registry = await this.getRegistry();
    this.startWatching();
  }

  private getFileSystemRegistryUri(): string | null {
    if (!this.registry) return null;

    if (this.registry.type === RegistryType.FileSystem) {
      return this.registry.uri;
    }

    if (this.registry.type === RegistryType.Merged) {
      // Return the first FileSystem registry within a MergedRegistry
      const merged = this.registry as MergedRegistry;
      const fsRegistry = merged.registries.find(
        (r) => r.type === RegistryType.FileSystem,
      );
      return fsRegistry?.uri ?? null;
    }

    return null;
  }

  private startWatching() {
    const fsUri = this.getFileSystemRegistryUri();
    if (!fsUri) return;

    const watchPath = fsUri.replace(/^file:\/\//, '');

    try {
      this.watcher = watch(
        watchPath,
        { recursive: true },
        (event, filename) => {
          if (filename?.match(/\.(yaml|json)$/)) {
            this.logger.info({ event, filename }, 'Registry file changed');
            this.markDirty();
          }
        },
      );
      this.logger.info({ path: watchPath }, 'Watching registry for changes');
    } catch (err) {
      this.logger.warn(
        { err, path: watchPath },
        'Failed to watch registry, falling back to polling',
      );
    }
  }

  private markDirty() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.isDirty = true;
    }, 500);
  }

  async getCurrentRegistry(): Promise<IRegistry> {
    const now = Date.now();
    const isWatching = !!this.getFileSystemRegistryUri();
    const shouldRefresh =
      this.isDirty ||
      (!isWatching && now - this.lastRefresh > this.refreshInterval) ||
      !this.registry;

    if (shouldRefresh) {
      if (this.refreshPromise) {
        return this.refreshPromise;
      }

      this.logger.info('Refreshing registry cache...');
      this.refreshPromise = this.getRegistry();
      try {
        this.registry = await this.refreshPromise;
        this.isDirty = false;
        this.lastRefresh = now;
      } finally {
        this.refreshPromise = null;
      }
    }

    return this.registry!;
  }

  async withRegistry<T>(
    operation: (registry: IRegistry) => Promise<T>,
  ): Promise<T> {
    const registry = await this.getCurrentRegistry();
    return operation(registry);
  }

  stop() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
  }
}
