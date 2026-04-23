import { expect } from 'vitest';

import type { MultiProvider } from '@hyperlane-xyz/sdk';

import type { IActionTracker } from './IActionTracker.js';
import { InflightContextAdapter } from './InflightContextAdapter.js';
import type { RebalanceIntent, Transfer } from './types.js';

describe('InflightContextAdapter', () => {
  let actionTracker: IActionTracker;
  let multiProvider: MultiProvider;
  let adapter: InflightContextAdapter;

  beforeEach(() => {
    actionTracker = {
      getActiveRebalanceIntents: vi.fn(),
      getInProgressTransfers: vi.fn(),
      getActionsForIntent: vi.fn(),
    } as any;

    multiProvider = {
      getChainName: vi.fn(),
    } as any;

    adapter = new InflightContextAdapter(
      actionTracker as any,
      multiProvider as any,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getInflightContext', () => {
    it('should return both pendingRebalances and pendingTransfers', async () => {
      const mockIntents: RebalanceIntent[] = [
        {
          id: 'intent1',
          origin: 1,
          destination: 2,
          amount: 1000n,
          status: 'not_started',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      const mockTransfers: Transfer[] = [
        {
          id: 'transfer1',
          origin: 1,
          destination: 2,
          amount: 500n,
          messageId: '0x123',
          sender: '0xabc' as any,
          recipient: '0xdef' as any,
          status: 'in_progress',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      (actionTracker.getActiveRebalanceIntents as any).mockResolvedValue(
        mockIntents,
      );
      (actionTracker.getInProgressTransfers as any).mockResolvedValue(
        mockTransfers,
      );
      (actionTracker.getActionsForIntent as any).mockResolvedValue([]); // No actions
      (multiProvider.getChainName as any).mockImplementation((id: number) => {
        if (id === 1) return 'ethereum';
        if (id === 2) return 'arbitrum';
        return undefined;
      });

      const result = await adapter.getInflightContext();

      expect(result.pendingRebalances).toHaveLength(1);
      expect(result.pendingRebalances[0]).toEqual({
        origin: 'ethereum',
        destination: 'arbitrum',
        amount: 1000n,
        deliveredAmount: 0n,
        awaitingDeliveryAmount: 0n,
        executionMethod: undefined,
        bridge: undefined,
      });

      expect(result.pendingTransfers).toHaveLength(1);
      expect(result.pendingTransfers[0]).toEqual({
        origin: 'ethereum',
        destination: 'arbitrum',
        amount: 500n,
      });
    });

    it('should handle empty arrays', async () => {
      (actionTracker.getActiveRebalanceIntents as any).mockResolvedValue([]);
      (actionTracker.getInProgressTransfers as any).mockResolvedValue([]);

      const result = await adapter.getInflightContext();

      expect(Array.isArray(result.pendingRebalances)).toBe(true);
      expect(Array.isArray(result.pendingTransfers)).toBe(true);
    });

    it('should correctly convert domain IDs to chain names', async () => {
      const mockIntents: RebalanceIntent[] = [
        {
          id: 'intent1',
          origin: 137,
          destination: 10,
          amount: 2000n,
          status: 'not_started',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      const mockTransfers: Transfer[] = [
        {
          id: 'transfer1',
          origin: 137,
          destination: 10,
          amount: 300n,
          messageId: '0x456',
          sender: '0x111' as any,
          recipient: '0x222' as any,
          status: 'in_progress',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      (actionTracker.getActiveRebalanceIntents as any).mockResolvedValue(
        mockIntents,
      );
      (actionTracker.getInProgressTransfers as any).mockResolvedValue(
        mockTransfers,
      );
      (actionTracker.getActionsForIntent as any).mockResolvedValue([]);
      (multiProvider.getChainName as any).mockImplementation((id: number) => {
        if (id === 137) return 'polygon';
        if (id === 10) return 'optimism';
        return undefined;
      });

      const result = await adapter.getInflightContext();

      expect(result.pendingRebalances[0].origin).toBe('polygon');
      expect(result.pendingRebalances[0].destination).toBe('optimism');
      expect(result.pendingTransfers[0].origin).toBe('polygon');
      expect(result.pendingTransfers[0].destination).toBe('optimism');
    });

    it('should handle multiple intents and transfers', async () => {
      const mockIntents: RebalanceIntent[] = [
        {
          id: 'intent1',
          origin: 1,
          destination: 2,
          amount: 1000n,
          status: 'not_started',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: 'intent2',
          origin: 2,
          destination: 3,
          amount: 1500n,
          status: 'in_progress',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      const mockTransfers: Transfer[] = [
        {
          id: 'transfer1',
          origin: 1,
          destination: 2,
          amount: 500n,
          messageId: '0x123',
          sender: '0xabc' as any,
          recipient: '0xdef' as any,
          status: 'in_progress',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: 'transfer2',
          origin: 3,
          destination: 1,
          amount: 750n,
          messageId: '0x789',
          sender: '0x333' as any,
          recipient: '0x444' as any,
          status: 'in_progress',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      (actionTracker.getActiveRebalanceIntents as any).mockResolvedValue(
        mockIntents,
      );
      (actionTracker.getInProgressTransfers as any).mockResolvedValue(
        mockTransfers,
      );
      (actionTracker.getActionsForIntent as any).mockResolvedValue([]);
      (multiProvider.getChainName as any).mockImplementation((id: number) => {
        if (id === 1) return 'ethereum';
        if (id === 2) return 'arbitrum';
        if (id === 3) return 'optimism';
        return undefined;
      });

      const result = await adapter.getInflightContext();

      expect(result.pendingRebalances).toHaveLength(2);
      expect(result.pendingTransfers).toHaveLength(2);
    });
  });
});
