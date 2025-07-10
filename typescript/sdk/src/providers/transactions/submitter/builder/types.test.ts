import { expect } from 'chai';

import { Address, assert } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import {
  ChainSubmissionStrategy,
  ChainSubmissionStrategySchema,
  SubmissionStrategy,
  SubmissionStrategySchema,
} from './types.js';

describe('ChainSubmissionStrategySchema', () => {
  const CHAIN_MOCK: ChainName = 'ethereum';
  const DESTINATION_CHAIN_MOCK: ChainName = 'arbitrum';
  const VERSION_MOCK: string = '1.0.0';
  const ADDRESS_MOCK: Address = '0x1234567890123456789012345678901234567890';
  const OWNER_ADDRESS_MOCK: Address =
    '0x9876543210987654321098765432109876543210';

  describe('SubmissionStrategySchema', () => {
    it('should fail parsing invalid submission strategy', () => {
      const invalidStrategy = {
        submitter: {
          type: 'invalid',
        },
      };

      const result = SubmissionStrategySchema.safeParse(invalidStrategy);
      expect(result.success).to.be.false;
    });
  });

  const testCases: ReadonlyArray<SubmissionStrategy> = [
    {
      submitter: {
        type: TxSubmitterType.JSON_RPC,
        chain: CHAIN_MOCK,
        userAddress: ADDRESS_MOCK,
      },
    },
    {
      submitter: {
        type: TxSubmitterType.IMPERSONATED_ACCOUNT,
        chain: CHAIN_MOCK,
        userAddress: ADDRESS_MOCK,
      },
    },
    {
      submitter: {
        type: TxSubmitterType.GNOSIS_SAFE,
        chain: CHAIN_MOCK,
        safeAddress: ADDRESS_MOCK,
      },
    },
    {
      submitter: {
        type: TxSubmitterType.GNOSIS_TX_BUILDER,
        chain: CHAIN_MOCK,
        version: VERSION_MOCK,
        safeAddress: ADDRESS_MOCK,
      },
    },
    {
      submitter: {
        type: TxSubmitterType.INTERCHAIN_ACCOUNT,
        chain: CHAIN_MOCK,
        owner: OWNER_ADDRESS_MOCK,
        destinationChain: DESTINATION_CHAIN_MOCK,
        internalSubmitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN_MOCK,
          userAddress: ADDRESS_MOCK,
        },
      },
    },
  ];

  for (const testCase of testCases) {
    describe(testCase.submitter.type, () => {
      it(`should parse valid ${testCase.submitter.type} submission strategy`, () => {
        const result = SubmissionStrategySchema.safeParse(testCase);
        expect(result.success).to.be.true;
      });

      it(`should parse valid chain submission strategy with ${testCase.submitter.type}`, () => {
        const validChainStrategy: ChainSubmissionStrategy = {
          [CHAIN_MOCK]: testCase,
        };

        const result =
          ChainSubmissionStrategySchema.safeParse(validChainStrategy);
        expect(result.success).to.be.true;
        if (result.success) {
          expect(result.data[CHAIN_MOCK].submitter.type).to.equal(
            testCase.submitter.type,
          );
        }
      });
    });
  }

  describe(TxSubmitterType.INTERCHAIN_ACCOUNT, () => {
    it(`should set the internalSubmitter to ${TxSubmitterType.JSON_RPC} if no internalSubmitter is set`, () => {
      const emptyStrategy = {
        [DESTINATION_CHAIN_MOCK]: {
          submitter: {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: CHAIN_MOCK,
            owner: OWNER_ADDRESS_MOCK,
          },
        },
      };

      const result = ChainSubmissionStrategySchema.safeParse(emptyStrategy);
      expect(result.success).to.be.true;
      assert(result.success, 'Expected valid chain submission strategy');

      const { data } = result;
      expect(data[DESTINATION_CHAIN_MOCK].submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      assert(
        data[DESTINATION_CHAIN_MOCK].submitter.type ===
          TxSubmitterType.INTERCHAIN_ACCOUNT,
        `Expected ${TxSubmitterType.INTERCHAIN_ACCOUNT}`,
      );
      expect(data[DESTINATION_CHAIN_MOCK].submitter.chain).to.equal(CHAIN_MOCK);
      expect(data[DESTINATION_CHAIN_MOCK].submitter.owner).to.equal(
        OWNER_ADDRESS_MOCK,
      );
      expect(
        data[DESTINATION_CHAIN_MOCK].submitter.internalSubmitter.type,
      ).to.equal(TxSubmitterType.JSON_RPC);
      expect(
        data[DESTINATION_CHAIN_MOCK].submitter.internalSubmitter.chain,
      ).to.equal(CHAIN_MOCK);
    });

    const unsetOwnerTestCases = testCases.filter(
      (config) =>
        config.submitter.type !== TxSubmitterType.INTERCHAIN_ACCOUNT &&
        config.submitter.type !== TxSubmitterType.GNOSIS_SAFE &&
        config.submitter.type !== TxSubmitterType.GNOSIS_TX_BUILDER,
    );

    for (const testCase of unsetOwnerTestCases) {
      it(`should fail if the internalSubmitter is not a multisig and the owner is not set (${testCase.submitter.type})`, () => {
        const emptyStrategy = {
          [DESTINATION_CHAIN_MOCK]: {
            submitter: {
              type: TxSubmitterType.INTERCHAIN_ACCOUNT,
              chain: CHAIN_MOCK,
              internalSubmitter: testCase,
            },
          },
        };

        const result = ChainSubmissionStrategySchema.safeParse(emptyStrategy);
        expect(result.success).to.be.false;
      });
    }

    it('should preprocess interchain account strategy and set destinationChain from key', () => {
      const inputStrategy = {
        [DESTINATION_CHAIN_MOCK]: {
          submitter: {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: CHAIN_MOCK,
            owner: OWNER_ADDRESS_MOCK,
            internalSubmitter: {
              type: TxSubmitterType.JSON_RPC,
              userAddress: ADDRESS_MOCK,
            },
          },
        },
      };

      const result = ChainSubmissionStrategySchema.safeParse(inputStrategy);
      expect(result.success).to.be.true;
      if (result.success) {
        const icaSubmitter = result.data[DESTINATION_CHAIN_MOCK].submitter;
        if (icaSubmitter.type === TxSubmitterType.INTERCHAIN_ACCOUNT) {
          expect(icaSubmitter.destinationChain).to.equal(
            DESTINATION_CHAIN_MOCK,
          );
          expect(icaSubmitter.internalSubmitter.chain).to.equal(CHAIN_MOCK);
        }
      }
    });

    describe('with multisig internal submitter', () => {
      const testCases = [
        {
          type: TxSubmitterType.GNOSIS_SAFE,
          safeAddress: ADDRESS_MOCK,
        },
        {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          safeAddress: ADDRESS_MOCK,
          version: VERSION_MOCK,
        },
      ];

      for (const testCase of testCases) {
        it(`should set the owner field from the multisig address (${testCase.type})`, () => {
          const inputStrategy = {
            [DESTINATION_CHAIN_MOCK]: {
              submitter: {
                type: TxSubmitterType.INTERCHAIN_ACCOUNT,
                chain: CHAIN_MOCK,
                destinationChain: DESTINATION_CHAIN_MOCK,
                internalSubmitter: testCase,
              },
            },
          };

          const result = ChainSubmissionStrategySchema.safeParse(inputStrategy);

          expect(result.success).to.be.true;
          assert(result.success, 'Expected parsing to be successful');

          const icaSubmitter = result.data[DESTINATION_CHAIN_MOCK].submitter;
          expect(icaSubmitter.type).to.equal(
            TxSubmitterType.INTERCHAIN_ACCOUNT,
          );
          assert(
            icaSubmitter.type === TxSubmitterType.INTERCHAIN_ACCOUNT,
            `Expected type to be ${TxSubmitterType.INTERCHAIN_ACCOUNT}`,
          );

          expect(icaSubmitter.chain).to.equal(CHAIN_MOCK);
          expect(icaSubmitter.destinationChain).to.equal(
            DESTINATION_CHAIN_MOCK,
          );
          expect(icaSubmitter.owner).to.equal(ADDRESS_MOCK);
          expect(icaSubmitter.internalSubmitter.type).to.equal(testCase.type);

          assert(
            icaSubmitter.internalSubmitter.type ===
              TxSubmitterType.GNOSIS_SAFE ||
              icaSubmitter.internalSubmitter.type ===
                TxSubmitterType.GNOSIS_TX_BUILDER,
            'Expected internal submitter to be a multisig type',
          );
          expect(icaSubmitter.internalSubmitter.safeAddress).to.equal(
            ADDRESS_MOCK,
          );
        });

        it(`should fail validation when interchain account owner and multisig address do not match (${testCase.type})`, () => {
          const invalidStrategy = {
            [DESTINATION_CHAIN_MOCK]: {
              submitter: {
                type: TxSubmitterType.INTERCHAIN_ACCOUNT,
                chain: CHAIN_MOCK,
                owner: OWNER_ADDRESS_MOCK, // Different from safeAddress
                destinationChain: DESTINATION_CHAIN_MOCK,
                internalSubmitter: testCase,
              },
            },
          };

          const result =
            ChainSubmissionStrategySchema.safeParse(invalidStrategy);
          expect(result.success).to.be.false;
          if (!result.success) {
            expect(result.error.issues[0].message).to.include(
              'Interchain account owner address and multisig address must match',
            );
          }
        });

        it(`should pass validation when interchain account owner and multisig address match (${testCase.type})`, () => {
          const validStrategy = {
            [DESTINATION_CHAIN_MOCK]: {
              submitter: {
                type: TxSubmitterType.INTERCHAIN_ACCOUNT,
                chain: CHAIN_MOCK,
                owner: ADDRESS_MOCK, // Same as safeAddress
                destinationChain: DESTINATION_CHAIN_MOCK,
                internalSubmitter: testCase,
              },
            },
          };

          const result = ChainSubmissionStrategySchema.safeParse(validStrategy);
          expect(result.success).to.be.true;
        });
      }
    });
  });

  describe('ChainSubmissionStrategySchema general behavior', () => {
    it('should handle multiple chains in strategy', () => {
      const multiChainStrategy: ChainSubmissionStrategy = {
        [CHAIN_MOCK]: {
          submitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN_MOCK,
            userAddress: ADDRESS_MOCK,
          },
        },
        [DESTINATION_CHAIN_MOCK]: {
          submitter: {
            type: TxSubmitterType.GNOSIS_SAFE,
            chain: DESTINATION_CHAIN_MOCK,
            safeAddress: OWNER_ADDRESS_MOCK,
          },
        },
      };

      const result =
        ChainSubmissionStrategySchema.safeParse(multiChainStrategy);
      expect(result.success).to.be.true;
      if (result.success) {
        expect(Object.keys(result.data)).to.have.length(2);
        expect(result.data[CHAIN_MOCK].submitter.type).to.equal(
          TxSubmitterType.JSON_RPC,
        );
        expect(result.data[DESTINATION_CHAIN_MOCK].submitter.type).to.equal(
          TxSubmitterType.GNOSIS_SAFE,
        );
      }
    });

    it('should fail parsing invalid chain names', () => {
      const invalidChainStrategy = {
        'invalid-chain': {
          submitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: 'invalid-chain',
            userAddress: ADDRESS_MOCK,
          },
        },
      };

      const result =
        ChainSubmissionStrategySchema.safeParse(invalidChainStrategy);
      expect(result.success).to.be.false;
    });

    it('should handle empty strategy object', () => {
      const emptyStrategy = {};

      const result = ChainSubmissionStrategySchema.safeParse(emptyStrategy);
      expect(result.success).to.be.true; // Empty object should be valid
      if (result.success) {
        expect(Object.keys(result.data)).to.have.length(0);
      }
    });
  });
});
