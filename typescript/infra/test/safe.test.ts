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
const ownerF = '0x00000000000000000000000000000000000000f6';
const zeroAddress = '0x0000000000000000000000000000000000000000';

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

type ExpectedSafeCall = {
  name:
    | 'swapOwner'
    | 'removeOwner'
    | 'addOwnerWithThreshold'
    | 'changeThreshold';
  args: (string | number)[];
};

function expectSafeCall(data: string, expected: ExpectedSafeCall) {
  const call = decodeSafeCall(data);
  expect(call.name).to.equal(expected.name);
  expect(call.args).to.have.lengthOf(expected.args.length);

  for (let i = 0; i < expected.args.length; i++) {
    const expectedArg = expected.args[i];
    if (typeof expectedArg === 'string') {
      expectSameAddress(call.args[i], expectedArg);
    } else {
      expect(call.args[i].toNumber()).to.equal(expectedArg);
    }
  }
}

function expectSafeCalls(
  transactions: { data: string }[],
  expectedCalls: ExpectedSafeCall[],
) {
  expect(transactions).to.have.lengthOf(expectedCalls.length);
  for (let i = 0; i < expectedCalls.length; i++) {
    expectSafeCall(transactions[i].data, expectedCalls[i]);
  }
}

async function expectRejection(promise: Promise<unknown>, message: string) {
  try {
    await promise;
    throw new Error('Expected promise to reject');
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
    const productionOwners = Array.from({ length: 9 }, (_, i) =>
      ownerFixture(i),
    );
    const productionNewOwner = ownerFixture(9);

    const updateCases: {
      name: string;
      currentOwners: string[];
      currentThreshold: number;
      expectedOwners: string[];
      newThreshold: number;
      proposer?: string;
      expectedCalls: ExpectedSafeCall[];
    }[] = [
      {
        name: 'swap overlapping owners and remove surplus owners with final threshold',
        currentOwners: [ownerA, ownerB, ownerC],
        currentThreshold: 3,
        expectedOwners: [ownerD],
        newThreshold: 1,
        expectedCalls: [
          { name: 'swapOwner', args: [sentinelOwners, ownerA, ownerD] },
          { name: 'removeOwner', args: [ownerD, ownerB, 1] },
          { name: 'removeOwner', args: [ownerD, ownerC, 1] },
        ],
      },
      {
        name: 'support the production 9-to-7 signer rotation shape',
        currentOwners: productionOwners,
        currentThreshold: 4,
        expectedOwners: [...productionOwners.slice(3), productionNewOwner],
        newThreshold: 3,
        proposer: productionOwners[3],
        expectedCalls: [
          {
            name: 'swapOwner',
            args: [sentinelOwners, productionOwners[0], productionNewOwner],
          },
          {
            name: 'removeOwner',
            args: [productionNewOwner, productionOwners[1], 3],
          },
          {
            name: 'removeOwner',
            args: [productionNewOwner, productionOwners[2], 3],
          },
        ],
      },
      {
        name: 'use each Safe owner order for linked-list prevOwner values',
        currentOwners: [ownerB, ownerA, ownerC],
        currentThreshold: 3,
        expectedOwners: [ownerD],
        newThreshold: 1,
        expectedCalls: [
          { name: 'swapOwner', args: [sentinelOwners, ownerB, ownerD] },
          { name: 'removeOwner', args: [ownerD, ownerA, 1] },
          { name: 'removeOwner', args: [ownerD, ownerC, 1] },
        ],
      },
      {
        name: 'treat expected owner order as set membership',
        currentOwners: [ownerB, ownerA, ownerC],
        currentThreshold: 2,
        expectedOwners: [ownerC, ownerB, ownerA],
        newThreshold: 2,
        expectedCalls: [],
      },
      {
        name: 'remove the head owner with sentinel prevOwner',
        currentOwners: [ownerA, ownerB, ownerC],
        currentThreshold: 2,
        expectedOwners: [ownerB, ownerC],
        newThreshold: 2,
        expectedCalls: [
          { name: 'removeOwner', args: [sentinelOwners, ownerA, 2] },
        ],
      },
      {
        name: 'add surplus owners and set final threshold on the last add',
        currentOwners: [ownerA],
        currentThreshold: 1,
        expectedOwners: [ownerA, ownerB, ownerC],
        newThreshold: 2,
        expectedCalls: [
          { name: 'addOwnerWithThreshold', args: [ownerB, 1] },
          { name: 'addOwnerWithThreshold', args: [ownerC, 2] },
        ],
      },
      {
        name: 'keep threshold change separate for symmetric swaps',
        currentOwners: [ownerA, ownerB],
        currentThreshold: 1,
        expectedOwners: [ownerA, ownerC],
        newThreshold: 2,
        expectedCalls: [
          { name: 'swapOwner', args: [ownerA, ownerB, ownerC] },
          { name: 'changeThreshold', args: [2] },
        ],
      },
      {
        name: 'use post-swap owners as prevOwner for consecutive swaps',
        currentOwners: [ownerA, ownerB, ownerC],
        currentThreshold: 2,
        expectedOwners: [ownerD, ownerE, ownerC],
        newThreshold: 2,
        expectedCalls: [
          { name: 'swapOwner', args: [sentinelOwners, ownerA, ownerD] },
          { name: 'swapOwner', args: [ownerD, ownerB, ownerE] },
        ],
      },
      {
        name: 'pin asymmetric multi-swap pairing and trailing removeOwner',
        currentOwners: [ownerA, ownerB, ownerC, ownerD],
        currentThreshold: 3,
        expectedOwners: [ownerD, ownerF, ownerE],
        newThreshold: 2,
        expectedCalls: [
          { name: 'swapOwner', args: [sentinelOwners, ownerA, ownerE] },
          { name: 'swapOwner', args: [ownerE, ownerB, ownerF] },
          { name: 'removeOwner', args: [ownerF, ownerC, 2] },
        ],
      },
    ];

    for (const testCase of updateCases) {
      // eslint-disable-next-line jest/expect-expect -- expectSafeCalls asserts decoded calldata
      it(`should ${testCase.name}`, async () => {
        const safeSdk = createMockSafeSdk({
          owners: testCase.currentOwners,
          threshold: testCase.currentThreshold,
        });

        const transactions = await updateSafeOwner({
          safeSdk,
          owners: testCase.expectedOwners,
          threshold: testCase.newThreshold,
          proposer: testCase.proposer,
        });

        expectSafeCalls(transactions, testCase.expectedCalls);
      });
    }

    const rejectionCases: {
      name: string;
      currentOwners: string[];
      currentThreshold: number;
      expectedOwners: string[];
      newThreshold: number;
      proposer?: string;
      expectedMessage: string;
    }[] = [
      {
        name: 'thresholds above the final owner count',
        currentOwners: [ownerA, ownerB],
        currentThreshold: 1,
        expectedOwners: [ownerC],
        newThreshold: 2,
        expectedMessage: 'Safe threshold 2 exceeds owner count 1',
      },
      {
        name: 'zero thresholds',
        currentOwners: [ownerA],
        currentThreshold: 1,
        expectedOwners: [ownerA],
        newThreshold: 0,
        expectedMessage: 'Safe threshold 0 must be at least 1',
      },
      {
        name: 'empty owner configs',
        currentOwners: [ownerA],
        currentThreshold: 1,
        expectedOwners: [],
        newThreshold: 1,
        expectedMessage: 'Safe must have at least one owner',
      },
      {
        name: 'removing the proposer from the final owner set',
        currentOwners: [ownerA, ownerB, ownerC],
        currentThreshold: 2,
        expectedOwners: [ownerB, ownerC, ownerE],
        newThreshold: 2,
        proposer: ownerA,
        expectedMessage: `Proposer ${ownerA} must remain a Safe owner`,
      },
      {
        name: 'duplicate expected owners',
        currentOwners: [ownerA, ownerB],
        currentThreshold: 1,
        expectedOwners: [ownerA, ownerA],
        newThreshold: 1,
        expectedMessage: `Duplicate Safe owner ${ownerA}`,
      },
      {
        name: 'zero address expected owners',
        currentOwners: [ownerA],
        currentThreshold: 1,
        expectedOwners: [zeroAddress],
        newThreshold: 1,
        expectedMessage: 'Safe owner cannot be the zero address',
      },
      {
        name: 'sentinel expected owners',
        currentOwners: [ownerA],
        currentThreshold: 1,
        expectedOwners: [sentinelOwners],
        newThreshold: 1,
        expectedMessage: `Safe owner cannot be sentinel owner ${sentinelOwners}`,
      },
      {
        name: 'Safe self-ownership',
        currentOwners: [ownerA],
        currentThreshold: 1,
        expectedOwners: [safeAddress],
        newThreshold: 1,
        expectedMessage: `Safe owner cannot be the Safe itself ${safeAddress}`,
      },
    ];

    for (const testCase of rejectionCases) {
      // eslint-disable-next-line jest/expect-expect -- expectRejection asserts the thrown message
      it(`should reject ${testCase.name}`, async () => {
        const safeSdk = createMockSafeSdk({
          owners: testCase.currentOwners,
          threshold: testCase.currentThreshold,
        });

        await expectRejection(
          updateSafeOwner({
            safeSdk,
            owners: testCase.expectedOwners,
            threshold: testCase.newThreshold,
            proposer: testCase.proposer,
          }),
          testCase.expectedMessage,
        );
      });
    }
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
});
