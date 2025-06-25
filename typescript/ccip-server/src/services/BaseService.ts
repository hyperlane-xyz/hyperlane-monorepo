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
  namespace?: string;
}

export interface ServiceConfigWithMultiProvider extends ServiceConfig {
  multiProvider: MultiProvider;
}

export interface ServiceConfigWithBaseUrl
  extends ServiceConfigWithMultiProvider {
  baseUrl: string;
}

export interface ServiceFactory {
  create(config: ServiceConfig): Promise<BaseService>;
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
  static async create(_config: ServiceConfig): Promise<BaseService> {
    throw new Error('Service must implement static create method');
  }

  /**
   * Helper method to get a logger with service context.
   * Uses the passed logger (with request context) or falls back to instance logger.
   */
  protected getServiceLogger(logger: Logger): Logger {
    return logger.child({
      service: this.constructor.name,
    });
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
    const multiProvider = new MultiProvider({ ...metadata });
    return multiProvider;
  }
}
