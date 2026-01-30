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
  private refreshPromise: Promise<IRegistry> | null = null;
  private isDirty = false;

  constructor(
    private readonly getRegistry: () => Promise<IRegistry>,
    private readonly refreshInterval: number,
    private readonly logger: Logger,
    private readonly fileRegistryWatcher?: IWatcher,
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
      this.fileRegistryWatcher.watch(
        watchPath,
        () => this.markDirty(),
        (err) => {
          this.logger.warn(
            { err, path: watchPath },
            'Watcher error, refresh will only occur on restart',
          );
        },
      );
      this.logger.info({ path: watchPath }, 'Watching registry for changes');
    } catch (err) {
      this.logger.warn(
        { err, path: watchPath },
        'Failed to watch registry, refresh will only occur on restart',
      );
    }
  }

  private markDirty() {
    this.isDirty = true;
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
    if (this.fileRegistryWatcher) this.fileRegistryWatcher.stop();
  }
}
