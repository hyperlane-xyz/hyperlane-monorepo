import { expect } from 'vitest';
import { BigNumber } from 'ethers';

import { ISafe__factory } from '@hyperlane-xyz/core';

import { getOwnerChanges, parseSafeTx } from '../src/utils/safe.js';

describe('Safe Utils', () => {
  describe('getOwnerChanges', () => {
    it('should identify owners to add and remove', async () => {
      const currentOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
      ];
      const expectedOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000004', // new owner
        '0x0000000000000000000000000000000000000003',
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        currentOwners,
        expectedOwners,
      );

      expect(ownersToRemove).toEqual([
        '0x0000000000000000000000000000000000000002',
      ]);
      expect(ownersToAdd).toEqual([
        '0x0000000000000000000000000000000000000004',
      ]);
    });

    it('should return empty arrays when no changes', async () => {
      const currentOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        currentOwners,
        currentOwners,
      );

      expect(ownersToRemove).toEqual([]);
      expect(ownersToAdd).toEqual([]);
    });

    it('should handle multiple swaps', async () => {
      const currentOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
        '0x0000000000000000000000000000000000000004',
      ];
      const expectedOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000005', // replace 0x02
        '0x0000000000000000000000000000000000000006', // replace 0x03
        '0x0000000000000000000000000000000000000004',
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        currentOwners,
        expectedOwners,
      );

      expect(ownersToRemove).toHaveLength(2);
      expect(ownersToAdd).toHaveLength(2);
      expect(ownersToRemove).toContain(
        '0x0000000000000000000000000000000000000002',
      );
      expect(ownersToRemove).toContain(
        '0x0000000000000000000000000000000000000003',
      );
      expect(ownersToAdd).toContain(
        '0x0000000000000000000000000000000000000005',
      );
      expect(ownersToAdd).toContain(
        '0x0000000000000000000000000000000000000006',
      );
    });

    it('should be case-insensitive for addresses', async () => {
      const currentOwners = [
        '0xaBcd000000000000000000000000000000000001', // correctly checksummed
        '0x0000000000000000000000000000000000000002',
      ];
      const expectedOwners = [
        '0xabcd000000000000000000000000000000000001', // same address, lowercase
        '0x0000000000000000000000000000000000000003', // new
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        currentOwners,
        expectedOwners,
      );

      // eqAddress normalizes addresses, so the checksummed and lowercase versions should be treated as the same
      expect(ownersToRemove).toHaveLength(1);
      expect(ownersToAdd).toHaveLength(1);
      expect(ownersToRemove[0].toLowerCase()).toBe(
        '0x0000000000000000000000000000000000000002',
      );
      expect(ownersToAdd[0].toLowerCase()).toBe(
        '0x0000000000000000000000000000000000000003',
      );
    });
  });

  describe('parseSafeTx', () => {
    it('should parse swapOwner transaction using ISafe interface', () => {
      const safeInterface = ISafe__factory.createInterface();
      const oldOwner = '0x0000000000000000000000000000000000000002';
      const newOwner = '0x0000000000000000000000000000000000000004';
      const prevOwner = '0x0000000000000000000000000000000000000001';

      const data = safeInterface.encodeFunctionData('swapOwner', [
        prevOwner,
        oldOwner,
        newOwner,
      ]);

      const tx = {
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
        chain: 'test',
        timestamp: Date.now(),
      };

      const decoded = parseSafeTx(tx);

      expect(decoded.name).toBe('swapOwner');
      expect(decoded.args).toHaveLength(3);
      expect(decoded.args[0]).toBe(prevOwner);
      expect(decoded.args[1]).toBe(oldOwner);
      expect(decoded.args[2]).toBe(newOwner);
    });

    it('should parse addOwnerWithThreshold transaction using ISafe interface', () => {
      const safeInterface = ISafe__factory.createInterface();
      const newOwner = '0x0000000000000000000000000000000000000005';
      const threshold = 2;

      const data = safeInterface.encodeFunctionData('addOwnerWithThreshold', [
        newOwner,
        threshold,
      ]);

      const tx = {
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
        chain: 'test',
        timestamp: Date.now(),
      };

      const decoded = parseSafeTx(tx);

      expect(decoded.name).toBe('addOwnerWithThreshold');
      expect(decoded.args).toHaveLength(2);
      expect(decoded.args[0]).toBe(newOwner);
      expect(decoded.args[1].toNumber()).toBe(threshold);
    });

    it('should parse changeThreshold transaction using ISafe interface', () => {
      const safeInterface = ISafe__factory.createInterface();
      const newThreshold = 3;

      const data = safeInterface.encodeFunctionData('changeThreshold', [
        newThreshold,
      ]);

      const tx = {
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
        chain: 'test',
        timestamp: Date.now(),
      };

      const decoded = parseSafeTx(tx);

      expect(decoded.name).toBe('changeThreshold');
      expect(decoded.args).toHaveLength(1);
      expect(decoded.args[0].toNumber()).toBe(newThreshold);
    });
  });

  // Note: Testing createSwapOwnerTransactions and findPrevOwner would require
  // mocking the Safe SDK, which is complex. These functions should be tested
  // in integration tests or by running the script in dry-run mode against
  // actual Safe contracts on testnets.
  //
  // Key scenarios to test manually:
  // 1. Single owner swap
  // 2. Multiple consecutive owner swaps (to verify prevOwner calculation)
  // 3. Multiple non-consecutive owner swaps
  // 4. Swap first owner (prevOwner should be SENTINEL_OWNERS)
  // 5. Swap last owner
  // 6. Threshold change with swaps
  // 7. Threshold change without swaps
});
