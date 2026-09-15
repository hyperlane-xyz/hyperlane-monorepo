import type { Logger } from 'pino';

import {
  IRegistry,
  MergedRegistry,
  RegistryType,
} from '@hyperlane-xyz/registry';
import { assert } from '@hyperlane-xyz/utils';

import { IWatcher } from './watcherService.js';

export class RegistryService {
  private registry: IRegistry | null = null;
  private lastRefresh: number = Date.now();
  private dirtyGeneration = 0;
  private appliedDirtyGeneration = 0;
  private isWatcherActive = false;
  private refreshInFlight?: Promise<void>;

  constructor(
    private readonly getRegistry: () => Promise<IRegistry>,
    private readonly refreshInterval: number,
    private readonly logger: Logger,
    private readonly fileRegistryWatcher?: IWatcher,
  ) {}

  async initialize() {
    try {
      await this.refresh();
    } catch (err: unknown) {
      this.logger.error({ err }, 'Registry initialization failed');
      throw err;
    }
    this.startWatching();
  }

  private getFileSystemRegistryUri(): string | null {
    if (!this.registry) return null;

    if (this.registry.type === RegistryType.FileSystem) {
      return this.registry.uri;
    }

    if (this.registry.type === RegistryType.Merged) {
      // Return the first FileSystem registry within a MergedRegistry
      // TODO: Add support for multiple File registries when needed
      // We should also consider using a better watcher for performances reasons
      const merged = this.registry as MergedRegistry;
      const fsRegistry = merged.registries.find(
        (r) => r.type === RegistryType.FileSystem,
      );
      return fsRegistry?.uri ?? null;
    }

    return null;
  }

  private startWatching() {
    if (!this.fileRegistryWatcher) {
      this.logger.debug('No watcher found. Skipping');
      return;
    }
    const fsUri = this.getFileSystemRegistryUri();
    if (!fsUri) return;

    const watchPath = fsUri.replace(/^file:\/\//, '');

    try {
      this.isWatcherActive = true;
      this.fileRegistryWatcher.watch(
        watchPath,
        () => this.markDirty(),
        (err) => {
          this.isWatcherActive = false;
          this.logger.warn(
            { err, path: watchPath },
            'Watcher error, falling back to polling',
          );
        },
      );
      this.logger.info({ path: watchPath }, 'Watching registry for changes');
    } catch (err) {
      this.isWatcherActive = false;
      this.logger.warn(
        { err, path: watchPath },
        'Failed to watch registry, falling back to polling',
      );
    }
  }

  private markDirty() {
    this.dirtyGeneration++;
  }

  async getCurrentRegistry(): Promise<IRegistry> {
    const now = Date.now();
    const shouldRefresh =
      !this.registry ||
      this.dirtyGeneration > this.appliedDirtyGeneration ||
      (!this.isWatcherActive && now - this.lastRefresh > this.refreshInterval);

    if (shouldRefresh) {
      await this.refresh();
    }

    assert(this.registry, 'Could not fetch current registry');
    return this.registry;
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const dirtyGeneration = this.dirtyGeneration;
    const refresh = (async () => {
      this.logger.info('Refreshing registry cache...');
      try {
        const registry = await this.getRegistry();
        this.registry = registry;
        this.appliedDirtyGeneration = dirtyGeneration;
        this.lastRefresh = Date.now();
      } catch (err: unknown) {
        this.logger.error({ err }, 'Registry refresh failed');
        throw err;
      }
    })();
    this.refreshInFlight = refresh;
    try {
      await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    }
  }

  async withRegistry<T>(
    operation: (registry: IRegistry) => Promise<T>,
  ): Promise<T> {
    const registry = await this.getCurrentRegistry();
    return operation(registry);
  }

  stop() {
    if (this.fileRegistryWatcher) this.fileRegistryWatcher.stop();
  }
}
