import type { Logger } from 'pino';

import type { MultiProvider } from '@hyperlane-xyz/sdk';

import {
  type PendingTransferMiddlewareConfig,
  PendingTransferMiddlewareType,
} from '../../config/types.js';
import type { IExplorerClient } from '../../utils/ExplorerClient.js';

import { BlacklistIsmMiddleware } from './BlacklistIsmMiddleware.js';
import type { PendingTransferMiddleware } from './PendingTransferMiddleware.js';
import { RelayerDenylistMiddleware } from './RelayerDenylistMiddleware.js';

export interface PendingTransferMiddlewareDeps {
  routersByDomain: Record<number, string>;
  mailboxByDomain: Record<number, string>;
  multiProvider: MultiProvider;
  logger: Logger;
}

export interface PendingTransferMiddlewares {
  client: IExplorerClient;
  /** Set only when at least one middleware is configured. */
  isIgnoredTransfer?: (messageId: string) => boolean;
  /** Set only when at least one middleware is configured. */
  isIgnoredRebalanceAction?: (messageId: string) => boolean;
}

function createMiddleware(
  config: PendingTransferMiddlewareConfig,
  inner: IExplorerClient,
  deps: PendingTransferMiddlewareDeps,
): Promise<PendingTransferMiddleware> {
  switch (config.type) {
    case PendingTransferMiddlewareType.RelayerDenylist:
      return RelayerDenylistMiddleware.create(
        inner,
        {
          url: config.url,
          refreshIntervalMs: config.refreshIntervalSecs * 1_000,
        },
        deps.logger,
      );
    case PendingTransferMiddlewareType.BlacklistIsm:
      return BlacklistIsmMiddleware.create(
        inner,
        {
          refreshIntervalMs: config.refreshIntervalSecs * 1_000,
          routersByDomain: deps.routersByDomain,
          mailboxByDomain: deps.mailboxByDomain,
          multiProvider: deps.multiProvider,
        },
        deps.logger,
      );
  }
}

/**
 * Wraps `inner` with one middleware per configured item. Item 0 is the
 * innermost middleware, so it sees the raw Explorer result first and each
 * later item sees only what the earlier ones kept. With no items, `inner` is
 * returned unchanged.
 */
export async function buildPendingTransferMiddlewares(
  inner: IExplorerClient,
  configs: PendingTransferMiddlewareConfig[],
  deps: PendingTransferMiddlewareDeps,
): Promise<PendingTransferMiddlewares> {
  let outermost: PendingTransferMiddleware | undefined;
  for (const config of configs) {
    outermost = await createMiddleware(config, outermost ?? inner, deps);
  }

  if (!outermost) return { client: inner };

  deps.logger.info(
    { middlewares: configs.map((config) => config.type) },
    'Pending transfer middlewares enabled',
  );

  const client = outermost;
  return {
    client,
    isIgnoredTransfer: (messageId) => client.isIgnored(messageId),
    isIgnoredRebalanceAction: (messageId) =>
      client.isIgnoredRebalanceAction(messageId),
  };
}
