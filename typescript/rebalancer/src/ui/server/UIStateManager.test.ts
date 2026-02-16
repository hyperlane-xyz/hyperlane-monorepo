import { expect } from 'chai';

import type { ChainMap } from '@hyperlane-xyz/sdk';

import type { StrategyConfig } from '../../config/types.js';
import {
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
} from '../../config/types.js';
import type { InventoryBalances } from '../../interfaces/IInventoryMonitor.js';
import type {
  RebalanceAction,
  RebalanceIntent,
  Transfer,
} from '../../tracking/types.js';

import { UIStateManager } from './UIStateManager.js';

describe('UIStateManager', () => {
  let manager: UIStateManager;
  let domainToChainName: Map<number, string>;

  beforeEach(() => {
    domainToChainName = new Map([
      [1, 'ethereum'],
      [42161, 'arbitrum'],
      [10, 'optimism'],
    ]);
    manager = new UIStateManager(domainToChainName);
  });

  describe('updateFullState', () => {
    it('should compute balances with weighted strategy', () => {
      const rawBalances: ChainMap<bigint> = {
        ethereum: 600n,
        arbitrum: 200n,
        optimism: 200n,
      };

      const inventoryBalances: InventoryBalances = new Map([
        ['ethereum', { chainName: 'ethereum', balance: 0n, available: 0n }],
        ['arbitrum', { chainName: 'arbitrum', balance: 0n, available: 0n }],
        ['optimism', { chainName: 'optimism', balance: 0n, available: 0n }],
      ]);

      const strategyConfig: StrategyConfig[] = [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 60n, tolerance: 5n },
              bridge: '0x1234567890123456789012345678901234567890',
            },
            arbitrum: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: '0x1234567890123456789012345678901234567891',
            },
            optimism: {
              weighted: { weight: 20n, tolerance: 5n },
              bridge: '0x1234567890123456789012345678901234567892',
            },
          },
        },
      ];

      manager.updateFullState({
        rawBalances,
        inventoryBalances,
        strategyConfig,
        transfers: [],
        intents: [],
        actions: [],
      });

      const state = manager.getState();
      expect(state.balances).to.have.lengthOf(3);

      const ethBalance = state.balances.find((b) => b.chain === 'ethereum');
      expect(ethBalance).to.exist;
      expect(ethBalance!.routerCollateral).to.equal('600');
      expect(ethBalance!.inventory).to.equal('0');
      expect(ethBalance!.currentWeight).to.equal(60);
      expect(ethBalance!.targetWeight).to.equal(60);
      expect(ethBalance!.deviation).to.equal(0);

      const arbBalance = state.balances.find((b) => b.chain === 'arbitrum');
      expect(arbBalance).to.exist;
      expect(arbBalance!.currentWeight).to.equal(20);
      expect(arbBalance!.targetWeight).to.equal(20);
      expect(arbBalance!.deviation).to.equal(0);
    });

    it('should compute balances with inventory', () => {
      const rawBalances: ChainMap<bigint> = {
        ethereum: 500n,
        arbitrum: 300n,
      };

      const inventoryBalances: InventoryBalances = new Map([
        ['ethereum', { chainName: 'ethereum', balance: 100n, available: 100n }],
        ['arbitrum', { chainName: 'arbitrum', balance: 100n, available: 100n }],
      ]);

      const strategyConfig: StrategyConfig[] = [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 60n, tolerance: 5n },
              bridge: '0x1234567890123456789012345678901234567890',
            },
            arbitrum: {
              weighted: { weight: 40n, tolerance: 5n },
              bridge: '0x1234567890123456789012345678901234567891',
            },
          },
        },
      ];

      manager.updateFullState({
        rawBalances,
        inventoryBalances,
        strategyConfig,
        transfers: [],
        intents: [],
        actions: [],
      });

      const state = manager.getState();
      const ethBalance = state.balances.find((b) => b.chain === 'ethereum');
      expect(ethBalance).to.exist;
      expect(ethBalance!.routerCollateral).to.equal('500');
      expect(ethBalance!.inventory).to.equal('100');
      expect(ethBalance!.currentWeight).to.equal(60);
    });

    it('should handle non-weighted strategy', () => {
      const rawBalances: ChainMap<bigint> = {
        ethereum: 600n,
        arbitrum: 400n,
      };

      const inventoryBalances: InventoryBalances = new Map([
        ['ethereum', { chainName: 'ethereum', balance: 0n, available: 0n }],
        ['arbitrum', { chainName: 'arbitrum', balance: 0n, available: 0n }],
      ]);

      const strategyConfig: StrategyConfig[] = [
        {
          rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
          chains: {
            ethereum: {
              minAmount: {
                min: '100',
                target: '200',
                type: RebalancerMinAmountType.Absolute,
              },
              bridge: '0x1234567890123456789012345678901234567890',
            },
            arbitrum: {
              minAmount: {
                min: '100',
                target: '200',
                type: RebalancerMinAmountType.Absolute,
              },
              bridge: '0x1234567890123456789012345678901234567891',
            },
          },
        },
      ];

      manager.updateFullState({
        rawBalances,
        inventoryBalances,
        strategyConfig,
        transfers: [],
        intents: [],
        actions: [],
      });

      const state = manager.getState();
      const ethBalance = state.balances.find((b) => b.chain === 'ethereum');
      expect(ethBalance).to.exist;
      expect(ethBalance!.currentWeight).to.equal(60);
      expect(ethBalance!.targetWeight).to.be.null;
      expect(ethBalance!.deviation).to.be.null;
    });

    it('should handle zero total balance', () => {
      const rawBalances: ChainMap<bigint> = {
        ethereum: 0n,
        arbitrum: 0n,
      };

      const inventoryBalances: InventoryBalances = new Map([
        ['ethereum', { chainName: 'ethereum', balance: 0n, available: 0n }],
        ['arbitrum', { chainName: 'arbitrum', balance: 0n, available: 0n }],
      ]);

      const strategyConfig: StrategyConfig[] = [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            ethereum: {
              weighted: { weight: 60n, tolerance: 5n },
              bridge: '0x1234567890123456789012345678901234567890',
            },
            arbitrum: {
              weighted: { weight: 40n, tolerance: 5n },
              bridge: '0x1234567890123456789012345678901234567891',
            },
          },
        },
      ];

      manager.updateFullState({
        rawBalances,
        inventoryBalances,
        strategyConfig,
        transfers: [],
        intents: [],
        actions: [],
      });

      const state = manager.getState();
      state.balances.forEach((balance) => {
        expect(balance.currentWeight).to.equal(0);
      });
    });

    it('should enrich transfers with chain names', () => {
      const transfer: Transfer = {
        id: 'transfer-1',
        status: 'in_progress',
        origin: 1,
        destination: 42161,
        amount: 1000n,
        messageId: '0xabc',
        sender: '0xsender',
        recipient: '0xrecipient',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      manager.updateFullState({
        rawBalances: {},
        inventoryBalances: new Map(),
        strategyConfig: [],
        transfers: [transfer],
        intents: [],
        actions: [],
      });

      const state = manager.getState();
      expect(state.transfers).to.have.lengthOf(1);
      expect(state.transfers[0].originChainName).to.equal('ethereum');
      expect(state.transfers[0].destinationChainName).to.equal('arbitrum');
      expect(state.transfers[0].amount).to.equal('1000');
    });

    it('should handle unknown domain IDs', () => {
      const transfer: Transfer = {
        id: 'transfer-1',
        status: 'in_progress',
        origin: 999,
        destination: 888,
        amount: 1000n,
        messageId: '0xabc',
        sender: '0xsender',
        recipient: '0xrecipient',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      manager.updateFullState({
        rawBalances: {},
        inventoryBalances: new Map(),
        strategyConfig: [],
        transfers: [transfer],
        intents: [],
        actions: [],
      });

      const state = manager.getState();
      expect(state.transfers[0].originChainName).to.equal('unknown-999');
      expect(state.transfers[0].destinationChainName).to.equal('unknown-888');
    });

    it('should emit state event on update', (done) => {
      manager.on('state', (state) => {
        expect(state).to.have.property('balances');
        expect(state).to.have.property('transfers');
        expect(state).to.have.property('intents');
        expect(state).to.have.property('actions');
        done();
      });

      manager.updateFullState({
        rawBalances: {},
        inventoryBalances: new Map(),
        strategyConfig: [],
        transfers: [],
        intents: [],
        actions: [],
      });
    });

    it('should enrich intents with chain names', () => {
      const intent: RebalanceIntent = {
        id: 'intent-1',
        status: 'in_progress',
        origin: 1,
        destination: 42161,
        amount: 2000n,
        executionMethod: 'movable_collateral',
        bridge: '0xbridge',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      manager.updateFullState({
        rawBalances: {},
        inventoryBalances: new Map(),
        strategyConfig: [],
        transfers: [],
        intents: [intent],
        actions: [],
      });

      const state = manager.getState();
      expect(state.intents).to.have.lengthOf(1);
      expect(state.intents[0].originChainName).to.equal('ethereum');
      expect(state.intents[0].destinationChainName).to.equal('arbitrum');
      expect(state.intents[0].amount).to.equal('2000');
    });

    it('should enrich actions with chain names', () => {
      const action: RebalanceAction = {
        id: 'action-1',
        status: 'in_progress',
        type: 'rebalance_message',
        origin: 1,
        destination: 42161,
        amount: 3000n,
        intentId: 'intent-1',
        messageId: '0xmsg',
        txHash: '0xtx',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      manager.updateFullState({
        rawBalances: {},
        inventoryBalances: new Map(),
        strategyConfig: [],
        transfers: [],
        intents: [],
        actions: [action],
      });

      const state = manager.getState();
      expect(state.actions).to.have.lengthOf(1);
      expect(state.actions[0].originChainName).to.equal('ethereum');
      expect(state.actions[0].destinationChainName).to.equal('arbitrum');
      expect(state.actions[0].amount).to.equal('3000');
      expect(state.actions[0].txHash).to.equal('0xtx');
    });
  });
});
