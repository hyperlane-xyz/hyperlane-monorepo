import { expect } from 'chai';

import {
  checkAndHandleReorg,
  pruneBlockHashCache,
} from '../../src/db/reorg.js';

describe('reorg', () => {
  // Use unique chain IDs per test to avoid cache pollution between tests
  let testChainId = 1000;

  beforeEach(() => {
    testChainId++;
  });

  describe('checkAndHandleReorg', () => {
    it('returns false on first block (no previous hash)', async () => {
      const chainId = testChainId;
      const blockHeight = 100;
      const blockHash = '0xabc123' as `0x${string}`;

      const result = await checkAndHandleReorg(chainId, blockHeight, blockHash);

      expect(result).to.be.false;
    });

    it('returns false when same block hash seen again', async () => {
      const chainId = testChainId;
      const blockHeight = 100;
      const blockHash = '0xabc123' as `0x${string}`;

      // First call - caches the hash
      await checkAndHandleReorg(chainId, blockHeight, blockHash);

      // Second call with same hash - no reorg
      const result = await checkAndHandleReorg(chainId, blockHeight, blockHash);

      expect(result).to.be.false;
    });

    // Skip: ES module exports can't be stubbed with sinon.
    // Reorg detection with adapter calls is tested via integration tests.
    it.skip('detects reorg when block hash changes for same height', async () => {
      // This test requires mocking getAdapter() which isn't possible with ESM.
      // The cache logic is tested by other tests; adapter integration is
      // verified in integration tests with a real database.
    });

    it('handles different blocks at different heights independently', async () => {
      const chainId = testChainId;
      const hash1 = '0xblock100' as `0x${string}`;
      const hash2 = '0xblock101' as `0x${string}`;

      // Cache two different blocks
      await checkAndHandleReorg(chainId, 100, hash1);
      await checkAndHandleReorg(chainId, 101, hash2);

      // Both should return false on repeat (no reorg)
      const result1 = await checkAndHandleReorg(chainId, 100, hash1);
      const result2 = await checkAndHandleReorg(chainId, 101, hash2);

      expect(result1).to.be.false;
      expect(result2).to.be.false;
    });

    it('handles multiple chains independently', async () => {
      const chain1 = testChainId;
      const chain2 = testChainId + 100;
      const blockHeight = 100;
      const hash1 = '0xchain1block' as `0x${string}`;
      const hash2 = '0xchain2block' as `0x${string}`;

      // Cache blocks for two chains at same height
      await checkAndHandleReorg(chain1, blockHeight, hash1);
      await checkAndHandleReorg(chain2, blockHeight, hash2);

      // Each chain should track independently
      const result1 = await checkAndHandleReorg(chain1, blockHeight, hash1);
      const result2 = await checkAndHandleReorg(chain2, blockHeight, hash2);

      expect(result1).to.be.false;
      expect(result2).to.be.false;
    });
  });

  describe('pruneBlockHashCache', () => {
    it('prunes blocks older than safety margin', async () => {
      const chainId = testChainId;
      const currentHeight = 1000;
      const safetyMargin = 100;

      // Add blocks at various heights
      for (let h = 800; h <= 1000; h += 50) {
        await checkAndHandleReorg(chainId, h, `0xblock${h}` as `0x${string}`);
      }

      // Prune with currentHeight=1000, safetyMargin=100
      // Should keep blocks >= 900, prune blocks < 900
      const pruned = pruneBlockHashCache(chainId, currentHeight, safetyMargin);

      // Blocks at 800, 850 should be pruned (2 blocks)
      expect(pruned).to.equal(2);
    });

    it('only prunes blocks for specified chain', async () => {
      const chain1 = testChainId;
      const chain2 = testChainId + 100;

      // Add old blocks for both chains
      await checkAndHandleReorg(chain1, 100, '0xc1b100' as `0x${string}`);
      await checkAndHandleReorg(chain2, 100, '0xc2b100' as `0x${string}`);

      // Prune only chain1
      const pruned = pruneBlockHashCache(chain1, 1000, 256);

      // Only chain1's block should be pruned
      expect(pruned).to.equal(1);

      // chain2's block should still be cached (no reorg on repeat)
      const result = await checkAndHandleReorg(
        chain2,
        100,
        '0xc2b100' as `0x${string}`,
      );
      expect(result).to.be.false;
    });

    it('returns 0 when no blocks to prune', async () => {
      const chainId = testChainId;

      // Add recent blocks only
      await checkAndHandleReorg(chainId, 950, '0xblock950' as `0x${string}`);
      await checkAndHandleReorg(chainId, 1000, '0xblock1000' as `0x${string}`);

      // Prune with margin that keeps all blocks
      const pruned = pruneBlockHashCache(chainId, 1000, 256);

      expect(pruned).to.equal(0);
    });

    it('uses default safety margin of 256', async () => {
      const chainId = testChainId;
      const currentHeight = 1000;

      // Add block at height 700 (300 blocks old, should be pruned with default margin of 256)
      await checkAndHandleReorg(chainId, 700, '0xoldblock' as `0x${string}`);

      // Add block at height 800 (200 blocks old, should be kept with default margin)
      await checkAndHandleReorg(chainId, 800, '0xnewblock' as `0x${string}`);

      // Use default margin
      const pruned = pruneBlockHashCache(chainId, currentHeight);

      // Only block at 700 should be pruned
      expect(pruned).to.equal(1);
    });
  });
});
