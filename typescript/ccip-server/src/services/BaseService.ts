import { Router } from 'express';
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
  protected constructor(..._args: any[]) {
    this.router = Router();
  }

  static async initialize(_namespace: string): Promise<BaseService> {
    throw new Error('Service must implement static initialize method');
  }

  static async getMultiProvider(registryUri: string[] | undefined) {
    const registryUris = registryUri ?? [DEFAULT_GITHUB_REGISTRY];
    console.log('Using registry URIs', registryUris);
    const registry = getRegistry({
      registryUris: registryUris,
      enableProxy: true,
    });
    const metadata = await registry.getMetadata();
    const multiProvider = new MultiProvider({ ...metadata });
    return multiProvider;
  }
}
