import { Router } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';

import { DEFAULT_GITHUB_REGISTRY, IRegistry } from '@hyperlane-xyz/registry';
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

export interface ServiceConfigWithBaseUrl
  extends ServiceConfigWithMultiProvider {
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

  protected static async getRegistry(
    registryUri: string[] | undefined,
  ): Promise<IRegistry> {
    const registryUris = registryUri ?? [DEFAULT_GITHUB_REGISTRY];
    const registry = getRegistry({
      registryUris: registryUris,
      enableProxy: true,
    });
    return registry;
  }

  protected static async getMultiProvider(
    registryUri: string[] | undefined,
  ): Promise<MultiProvider> {
    const registry = await this.getRegistry(registryUri);
    const metadata = await registry.getMetadata();
    const multiProvider = new MultiProvider({ ...metadata });
    return multiProvider;
  }
}
