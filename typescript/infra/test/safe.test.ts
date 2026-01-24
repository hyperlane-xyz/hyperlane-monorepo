import { expect } from 'chai';
import { BigNumber } from 'ethers';

import { ISafe__factory } from '@hyperlane-xyz/core';
import { parseSafeTx } from '@hyperlane-xyz/sdk';

import { getOwnerChanges } from '../src/utils/safe.js';

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

      expect(ownersToRemove).to.deep.equal([
        '0x0000000000000000000000000000000000000002',
      ]);
      expect(ownersToAdd).to.deep.equal([
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

      expect(ownersToRemove).to.deep.equal([]);
      expect(ownersToAdd).to.deep.equal([]);
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

      expect(ownersToRemove).to.have.lengthOf(2);
      expect(ownersToAdd).to.have.lengthOf(2);
      expect(ownersToRemove).to.include(
        '0x0000000000000000000000000000000000000002',
      );
      expect(ownersToRemove).to.include(
        '0x0000000000000000000000000000000000000003',
      );
      expect(ownersToAdd).to.include(
        '0x0000000000000000000000000000000000000005',
      );
      expect(ownersToAdd).to.include(
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
      expect(ownersToRemove).to.have.lengthOf(1);
      expect(ownersToAdd).to.have.lengthOf(1);
      expect(ownersToRemove[0].toLowerCase()).to.equal(
        '0x0000000000000000000000000000000000000002',
      );
      expect(ownersToAdd[0].toLowerCase()).to.equal(
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

      expect(decoded.name).to.equal('swapOwner');
      expect(decoded.args).to.have.lengthOf(3);
      expect(decoded.args[0]).to.equal(prevOwner);
      expect(decoded.args[1]).to.equal(oldOwner);
      expect(decoded.args[2]).to.equal(newOwner);
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

      expect(decoded.name).to.equal('addOwnerWithThreshold');
      expect(decoded.args).to.have.lengthOf(2);
      expect(decoded.args[0]).to.equal(newOwner);
      expect(decoded.args[1].toNumber()).to.equal(threshold);
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

      expect(decoded.name).to.equal('changeThreshold');
      expect(decoded.args).to.have.lengthOf(1);
      expect(decoded.args[0].toNumber()).to.equal(newThreshold);
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
