import { expect } from 'chai';
import { pino } from 'pino';

import type { MultiProvider } from '@hyperlane-xyz/sdk';

import type { InventoryExecutionResult } from '../../interfaces/IRebalancer.js';
import type { InventoryRoute } from '../../interfaces/IStrategy.js';
import type { IActionTracker } from '../../tracking/IActionTracker.js';
import type { PartialInventoryIntent } from '../../tracking/types.js';
import { InventoryIntentResolver } from './IntentResolver.js';

const logger = pino({ level: 'silent' });

describe('InventoryIntentResolver', () => {
  it('fails clearly when continuing an inventory intent without an external bridge', async () => {
    const partialIntent: PartialInventoryIntent = {
      intent: {
        id: 'intent-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        status: 'in_progress',
        createdAt: 1,
        updatedAt: 1,
      },
      completedAmount: 0n,
      remaining: 100n,
      hasInflightDeposit: false,
    };
    const actionTracker = {
      getPartiallyFulfilledInventoryIntents: async () => [partialIntent],
    } as unknown as IActionTracker;
    const resolver = new InventoryIntentResolver(
      actionTracker,
      {} as MultiProvider,
      async (): Promise<InventoryExecutionResult> => {
        throw new Error('executeRoute should not be called');
      },
      () => {
        throw new Error('consumeSuccessfulRoute should not be called');
      },
      logger,
    );

    try {
      await resolver.rebalance([] as InventoryRoute[]);
      expect.fail('Expected resolver to reject');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'Inventory intent intent-1 is missing externalBridge',
      );
    }
  });
});
