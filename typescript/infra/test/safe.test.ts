import { expect } from 'chai';
import { BigNumber } from 'ethers';
import Safe from '@safe-global/protocol-kit';

import { ISafe__factory } from '@hyperlane-xyz/core';

import {
  getOwnerChanges,
  parseSafeTx,
  updateSafeOwner,
} from '../src/utils/safe.js';

const safeAddress = '0x1234567890123456789012345678901234567890';
const sentinelOwners = '0x0000000000000000000000000000000000000001';
const ownerA = '0x00000000000000000000000000000000000000a1';
const ownerB = '0x00000000000000000000000000000000000000b2';
const ownerC = '0x00000000000000000000000000000000000000c3';
const ownerD = '0x00000000000000000000000000000000000000d4';
const ownerE = '0x00000000000000000000000000000000000000e5';

function ownerFixture(index: number) {
  return `0x${(0xa0 + index).toString(16).padStart(40, '0')}`;
}

function createMockSafeSdk({
  owners,
  threshold,
}: {
  owners: string[];
  threshold: number;
}): Safe.default {
  const safeInterface = ISafe__factory.createInterface();

  return {
    getThreshold: async () => threshold,
    getOwners: async () => owners,
    getAddress: async () => safeAddress,
    createChangeThresholdTx: async (newThreshold: number) => ({
      data: {
        to: safeAddress,
        data: safeInterface.encodeFunctionData('changeThreshold', [
          newThreshold,
        ]),
        value: '0',
      },
    }),
  } as Safe.default;
}

function decodeSafeCall(data: string) {
  return ISafe__factory.createInterface().parseTransaction({
    data,
    value: BigNumber.from(0),
  });
}

function expectSameAddress(actual: string, expected: string) {
  expect(actual.toLowerCase()).to.equal(expected.toLowerCase());
}

async function expectUpdateSafeOwnerRejection(
  promise: Promise<unknown>,
  message: string,
) {
  try {
    await promise;
    throw new Error('Expected updateSafeOwner to reject');
  } catch (error) {
    expect((error as Error).message).to.include(message);
  }
}

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

  describe('updateSafeOwner', () => {
    it('should swap overlapping owners and remove surplus owners with final threshold', async () => {
      const safeSdk = createMockSafeSdk({
        owners: [ownerA, ownerB, ownerC],
        threshold: 3,
      });

      const transactions = await updateSafeOwner({
        safeSdk,
        owners: [ownerD],
        threshold: 1,
      });

      expect(transactions).to.have.lengthOf(3);

      const swap = decodeSafeCall(transactions[0].data);
      expect(swap.name).to.equal('swapOwner');
      expectSameAddress(swap.args[0], sentinelOwners);
      expectSameAddress(swap.args[1], ownerA);
      expectSameAddress(swap.args[2], ownerD);

      const firstRemove = decodeSafeCall(transactions[1].data);
      expect(firstRemove.name).to.equal('removeOwner');
      expectSameAddress(firstRemove.args[0], ownerD);
      expectSameAddress(firstRemove.args[1], ownerB);
      expect(firstRemove.args[2].toNumber()).to.equal(1);

      const secondRemove = decodeSafeCall(transactions[2].data);
      expect(secondRemove.name).to.equal('removeOwner');
      expectSameAddress(secondRemove.args[0], ownerD);
      expectSameAddress(secondRemove.args[1], ownerC);
      expect(secondRemove.args[2].toNumber()).to.equal(1);
    });

    it('should support the production 9-to-7 signer rotation shape', async () => {
      const currentOwners = Array.from({ length: 9 }, (_, i) =>
        ownerFixture(i),
      );
      const newOwner = ownerFixture(9);
      const safeSdk = createMockSafeSdk({
        owners: currentOwners,
        threshold: 4,
      });

      const transactions = await updateSafeOwner({
        safeSdk,
        owners: [...currentOwners.slice(3), newOwner],
        threshold: 3,
        proposer: currentOwners[3],
      });

      expect(transactions).to.have.lengthOf(3);

      const swap = decodeSafeCall(transactions[0].data);
      expect(swap.name).to.equal('swapOwner');
      expectSameAddress(swap.args[0], sentinelOwners);
      expectSameAddress(swap.args[1], currentOwners[0]);
      expectSameAddress(swap.args[2], newOwner);

      const firstRemove = decodeSafeCall(transactions[1].data);
      expect(firstRemove.name).to.equal('removeOwner');
      expectSameAddress(firstRemove.args[0], newOwner);
      expectSameAddress(firstRemove.args[1], currentOwners[1]);
      expect(firstRemove.args[2].toNumber()).to.equal(3);

      const secondRemove = decodeSafeCall(transactions[2].data);
      expect(secondRemove.name).to.equal('removeOwner');
      expectSameAddress(secondRemove.args[0], newOwner);
      expectSameAddress(secondRemove.args[1], currentOwners[2]);
      expect(secondRemove.args[2].toNumber()).to.equal(3);
    });

    it('should use each Safe owner order for linked-list prevOwner values', async () => {
      const safeSdk = createMockSafeSdk({
        owners: [ownerB, ownerA, ownerC],
        threshold: 3,
      });

      const transactions = await updateSafeOwner({
        safeSdk,
        owners: [ownerD],
        threshold: 1,
      });

      expect(transactions).to.have.lengthOf(3);

      const swap = decodeSafeCall(transactions[0].data);
      expect(swap.name).to.equal('swapOwner');
      expectSameAddress(swap.args[0], sentinelOwners);
      expectSameAddress(swap.args[1], ownerB);
      expectSameAddress(swap.args[2], ownerD);

      const firstRemove = decodeSafeCall(transactions[1].data);
      expect(firstRemove.name).to.equal('removeOwner');
      expectSameAddress(firstRemove.args[0], ownerD);
      expectSameAddress(firstRemove.args[1], ownerA);
      expect(firstRemove.args[2].toNumber()).to.equal(1);

      const secondRemove = decodeSafeCall(transactions[2].data);
      expect(secondRemove.name).to.equal('removeOwner');
      expectSameAddress(secondRemove.args[0], ownerD);
      expectSameAddress(secondRemove.args[1], ownerC);
      expect(secondRemove.args[2].toNumber()).to.equal(1);
    });

    it('should treat expected owner order as set membership', async () => {
      const safeSdk = createMockSafeSdk({
        owners: [ownerB, ownerA, ownerC],
        threshold: 2,
      });

      const transactions = await updateSafeOwner({
        safeSdk,
        owners: [ownerC, ownerB, ownerA],
        threshold: 2,
      });

      expect(transactions).to.deep.equal([]);
    });

    it('should remove the head owner with sentinel prevOwner', async () => {
      const safeSdk = createMockSafeSdk({
        owners: [ownerA, ownerB, ownerC],
        threshold: 2,
      });

      const transactions = await updateSafeOwner({
        safeSdk,
        owners: [ownerB, ownerC],
        threshold: 2,
      });

      expect(transactions).to.have.lengthOf(1);

      const remove = decodeSafeCall(transactions[0].data);
      expect(remove.name).to.equal('removeOwner');
      expectSameAddress(remove.args[0], sentinelOwners);
      expectSameAddress(remove.args[1], ownerA);
      expect(remove.args[2].toNumber()).to.equal(2);
    });

    it('should add surplus owners and set final threshold on the last add', async () => {
      const safeSdk = createMockSafeSdk({
        owners: [ownerA],
        threshold: 1,
      });

      const transactions = await updateSafeOwner({
        safeSdk,
        owners: [ownerA, ownerB, ownerC],
        threshold: 2,
      });

      expect(transactions).to.have.lengthOf(2);

      const firstAdd = decodeSafeCall(transactions[0].data);
      expect(firstAdd.name).to.equal('addOwnerWithThreshold');
      expectSameAddress(firstAdd.args[0], ownerB);
      expect(firstAdd.args[1].toNumber()).to.equal(1);

      const secondAdd = decodeSafeCall(transactions[1].data);
      expect(secondAdd.name).to.equal('addOwnerWithThreshold');
      expectSameAddress(secondAdd.args[0], ownerC);
      expect(secondAdd.args[1].toNumber()).to.equal(2);
    });

    it('should keep threshold change separate for symmetric swaps', async () => {
      const safeSdk = createMockSafeSdk({
        owners: [ownerA, ownerB],
        threshold: 1,
      });

      const transactions = await updateSafeOwner({
        safeSdk,
        owners: [ownerA, ownerC],
        threshold: 2,
      });

      expect(transactions).to.have.lengthOf(2);

      const swap = decodeSafeCall(transactions[0].data);
      expect(swap.name).to.equal('swapOwner');
      expectSameAddress(swap.args[0], ownerA);
      expectSameAddress(swap.args[1], ownerB);
      expectSameAddress(swap.args[2], ownerC);

      const thresholdChange = decodeSafeCall(transactions[1].data);
      expect(thresholdChange.name).to.equal('changeThreshold');
      expect(thresholdChange.args[0].toNumber()).to.equal(2);
    });

    it('should reject thresholds above the final owner count', async () => {
      const safeSdk = createMockSafeSdk({
        owners: [ownerA, ownerB],
        threshold: 1,
      });

      await expectUpdateSafeOwnerRejection(
        updateSafeOwner({
          safeSdk,
          owners: [ownerC],
          threshold: 2,
        }),
        'Safe threshold 2 exceeds owner count 1',
      );
    });

    it('should reject zero thresholds and empty owner configs', async () => {
      const safeSdk = createMockSafeSdk({
        owners: [ownerA],
        threshold: 1,
      });

      await expectUpdateSafeOwnerRejection(
        updateSafeOwner({
          safeSdk,
          owners: [ownerA],
          threshold: 0,
        }),
        'Safe threshold 0 must be at least 1',
      );

      await expectUpdateSafeOwnerRejection(
        updateSafeOwner({
          safeSdk,
          owners: [],
          threshold: 1,
        }),
        'Safe must have at least one owner',
      );
    });

    it('should reject removing the proposer from the final owner set', async () => {
      const safeSdk = createMockSafeSdk({
        owners: [ownerA, ownerB, ownerC],
        threshold: 2,
      });

      await expectUpdateSafeOwnerRejection(
        updateSafeOwner({
          safeSdk,
          owners: [ownerB, ownerC, ownerE],
          threshold: 2,
          proposer: ownerA,
        }),
        `Proposer ${ownerA} must remain a Safe owner`,
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
