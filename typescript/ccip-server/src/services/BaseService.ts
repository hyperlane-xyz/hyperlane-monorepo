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

export abstract class BaseService {
  public readonly router: Router;
  protected logger: Logger;

  protected constructor(...args: [...any[], Logger]) {
    this.router = Router();
    const logger = args[args.length - 1] as Logger;
    this.logger = logger;
  }

  static async initialize(
    _namespace: string,
    _logger: Logger,
  ): Promise<BaseService> {
    throw new Error('Service must implement static initialize method');
  }

  /**
   * Helper method to get a logger with service context.
   * Uses the passed logger (with request context) or falls back to instance logger.
   */
  protected getServiceLogger(logger?: Logger): Logger {
    return (logger || this.logger).child({
      service: this.constructor.name,
    });
  }

  static async getMultiProvider(registryUri: string[] | undefined) {
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
