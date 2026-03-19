import fs from 'fs';
import path from 'path';

import { Router } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';

export const REGISTRY_URI_SCHEMA = z
  .string()
  .transform((val) => val.split(',').map((s) => s.trim()))
  .optional();

export interface ServiceConfig {
  serviceName: string;
}

export interface ServiceConfigWithMultiProvider extends ServiceConfig {
  multiProvider: MultiProvider;
}

export interface ServiceConfigWithBaseUrl extends ServiceConfigWithMultiProvider {
  baseUrl: string;
}

export interface ServiceFactory {
  create(name: string): Promise<BaseService>;
}

export abstract class BaseService {
  public readonly router: Router;
  protected config: ServiceConfig;

  protected constructor(config: ServiceConfig) {
    this.router = Router();
    this.config = config;
  }

  /**
   * Factory method that subclasses must implement
   */
  static async create(_serviceName: string): Promise<BaseService> {
    throw new Error('Service must implement static create method');
  }

  /**
   * Helper method to add service context to a logger.
   */
  protected addLoggerServiceContext(logger: Logger): Logger {
    return logger.child({ service: this.constructor.name });
  }

  protected static async getMultiProvider(
    registryUri: string[] | undefined,
  ): Promise<MultiProvider> {
    const registryUris = registryUri ?? [DEFAULT_GITHUB_REGISTRY];
    const registry = getRegistry({
      registryUris: registryUris,
      enableProxy: true,
    });
    const metadata = await registry.getMetadata();
    BaseService.augmentMetadataFromRepoConfig(metadata);
    const multiProvider = new MultiProvider({ ...metadata });
    return multiProvider;
  }

  private static augmentMetadataFromRepoConfig(
    metadata: Record<string, unknown>,
  ): void {
    const repoConfig = path.resolve(
      process.cwd(),
      '..',
      '..',
      'rust',
      'main',
      'config',
      'mainnet_config.json',
    );

    if (!fs.existsSync(repoConfig)) return;

    const parsed = JSON.parse(fs.readFileSync(repoConfig, 'utf8'));
    const chains = parsed?.chains;
    if (!chains || typeof chains !== 'object') return;

    for (const [name, chainMetadata] of Object.entries(chains)) {
      if (!metadata[name]) {
        metadata[name] = chainMetadata;
      }
    }
  }
}
