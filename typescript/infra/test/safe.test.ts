import { expect } from 'chai';
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
