/**
 * State API for the Hyperlane Rebalancer.
 *
 * Exposes the rebalancer's in-memory state (balances, pending transfers,
 * active rebalance intents) via a lightweight Express API. This enables
 * external services like the Commandery pricing engine to compute
 * accurate fee quotes based on real-time inventory.
 *
 * Endpoints:
 *   GET /state     — full snapshot (balances + transfers + intents)
 *   GET /balances  — balances only (lightweight)
 *   GET /health    — service health check
 */

import express, { type Express } from 'express';
import type { Logger } from 'pino';

import type { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import type { IActionTracker } from '../tracking/IActionTracker.js';
import type { RawBalances } from '../interfaces/IStrategy.js';

export interface StateApiConfig {
  /** Port to listen on (default: 3001) */
  port?: number;
  /** Logger instance */
  logger: Logger;
}

export interface StateApiDeps {
  /** Function that returns the latest raw balances (set by RebalancerService) */
  getLatestBalances: () => RawBalances | null;
  /** Function that returns managed chain names */
  getChainNames: () => ChainName[];
  /** Action tracker for pending transfers and intents */
  actionTracker: IActionTracker;
}

export function createStateApi(
  deps: StateApiDeps,
  config: StateApiConfig,
): Express {
  assert(deps.actionTracker, 'actionTracker is required for state API');
  assert(deps.getLatestBalances, 'getLatestBalances is required for state API');
  assert(deps.getChainNames, 'getChainNames is required for state API');

  const app = express();
  const logger = config.logger.child({ module: 'state-api' });

  app.get('/state', async (_req, res) => {
    try {
      const balances = deps.getLatestBalances();
      const [transfers, intents] = await Promise.all([
        deps.actionTracker.getInProgressTransfers(),
        deps.actionTracker.getActiveRebalanceIntents(),
      ]);

      // Convert bigint balances to string for JSON serialization
      const balancesMap: ChainMap<string> = {};
      if (balances) {
        for (const [chain, balance] of Object.entries(balances)) {
          balancesMap[chain] = balance.toString();
        }
      }

      res.json({
        balances: balancesMap,
        chains: deps.getChainNames(),
        transfers: transfers.map((t) => ({
          origin: t.origin,
          destination: t.destination,
          amount: t.amount.toString(),
          status: t.status,
          messageId: t.messageId,
          createdAt: t.createdAt,
        })),
        intents: intents.map((i) => ({
          origin: i.origin,
          destination: i.destination,
          amount: i.amount.toString(),
          fulfilledAmount: i.fulfilledAmount.toString(),
          status: i.status,
          strategyType: i.strategyType,
          priority: i.priority,
        })),
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch state');
      res.status(500).json({ error: 'Internal error fetching state' });
    }
  });

  app.get('/balances', (_req, res) => {
    const balances = deps.getLatestBalances();
    if (!balances) {
      res
        .status(503)
        .json({ error: 'No balance data yet (monitor not started)' });
      return;
    }

    const balancesMap: ChainMap<string> = {};
    for (const [chain, balance] of Object.entries(balances)) {
      balancesMap[chain] = balance.toString();
    }
    res.json({ balances: balancesMap, timestamp: Date.now() });
  });

  app.get('/health', (_req, res) => {
    const balances = deps.getLatestBalances();
    res.json({
      status: balances ? 'ok' : 'waiting',
      hasBalances: balances !== null,
      chains: deps.getChainNames(),
      timestamp: Date.now(),
    });
  });

  return app;
}

export function startStateApi(app: Express, config: StateApiConfig): void {
  const port = config.port ?? 3001;
  app.listen(port, () => {
    config.logger.info(`State API listening on port ${port}`);
  });
}
