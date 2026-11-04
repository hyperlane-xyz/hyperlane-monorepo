import type { Logger } from 'pino';

import {
  IRegistry,
  MergedRegistry,
  RegistryType,
} from '@hyperlane-xyz/registry';
import { LazyAsync, assert } from '@hyperlane-xyz/utils';

import { IWatcher } from './watcherService.js';

const FILE_URI_PREFIX_REGEX = /^file:\/\//;

export class RegistryService {
  private registry: IRegistry | null = null;
  private lastRefresh: number = Date.now();
  private generation = 0;
  private refreshedGeneration = -1;
  private isWatcherActive = false;
  private readonly registryRefresh = new LazyAsync(() =>
    this.refreshRegistry(),
  );

  constructor(
    private readonly getRegistry: () => Promise<IRegistry>,
    private readonly refreshInterval: number,
    private readonly logger: Logger,
    private readonly fileRegistryWatcher?: IWatcher,
  ) {}

  async initialize() {
    try {
      await this.getCurrentRegistry();
      this.startWatching();
      // Watch registration follows the initial read. Refresh under the active
      // watcher so a change in that gap cannot become a permanently clean cache.
      await this.getCurrentRegistry();
    } catch (err: unknown) {
      this.stop();
      this.logger.error({ err }, 'Registry initialization failed');
      throw err;
    }
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
    if (this.isWatcherActive) return;
    if (!this.fileRegistryWatcher) {
      this.logger.debug('No watcher found. Skipping');
      return;
    }
    const fsUri = this.getFileSystemRegistryUri();
    if (!fsUri) return;

    const watchPath = fsUri.replace(FILE_URI_PREFIX_REGEX, '');

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
      this.markDirty();
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
    this.generation++;
  }

  private async refreshRegistry(): Promise<IRegistry> {
    // Events arriving during a read invalidate that snapshot. One shared
    // initializer retries until it can publish a snapshot for the current epoch.
    for (;;) {
      const generation = this.generation;
      const registry = await this.getRegistry();
      if (generation !== this.generation) continue;
      this.registry = registry;
      this.refreshedGeneration = generation;
      this.lastRefresh = Date.now();
      return registry;
    }
  }

  async getCurrentRegistry(): Promise<IRegistry> {
    const now = Date.now();
    const shouldRefresh =
      this.refreshedGeneration !== this.generation ||
      (!this.isWatcherActive &&
        now - this.lastRefresh > this.refreshInterval) ||
      !this.registry;

    if (shouldRefresh) {
      this.logger.info('Refreshing registry cache...');
      // Reset only the settled cache, never another caller's pending refresh.
      if (this.registryRefresh.isInitialized()) this.registryRefresh.reset();
      try {
        await this.registryRefresh.get();
        // A watcher can run between publication and LazyAsync settling. Recheck
        // after the shared promise so those callers cannot receive its stale epoch.
        if (this.refreshedGeneration !== this.generation)
          return this.getCurrentRegistry();
      } catch (err: unknown) {
        this.logger.error({ err }, 'Registry refresh failed');
        throw err;
      }
    }

    assert(this.registry, 'Could not fetch current registry');
    return this.registry;
  }

  async withRegistry<T>(
    operation: (registry: IRegistry) => Promise<T>,
  ): Promise<T> {
    const registry = await this.getCurrentRegistry();
    return operation(registry);
  }

  stop() {
    this.isWatcherActive = false;
    if (this.fileRegistryWatcher) this.fileRegistryWatcher.stop();
  }
}
