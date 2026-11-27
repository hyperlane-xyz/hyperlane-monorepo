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
    {
      submitter: {
        type: TxSubmitterType.TIMELOCK_CONTROLLER,
        chain: CHAIN_MOCK,
        timelockAddress: OWNER_ADDRESS_MOCK,
        proposerSubmitter: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          safeAddress: ADDRESS_MOCK,
          chain: CHAIN_MOCK,
          // Should not fail as it has a default value
          version: undefined as any,
        },
      },
    },
    {
      submitter: {
        type: TxSubmitterType.TIMELOCK_CONTROLLER,
        chain: CHAIN_MOCK,
        timelockAddress: OWNER_ADDRESS_MOCK,
        // It should be transformed to a bigint and not fail parsing
        delay: '10' as any,
        proposerSubmitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN_MOCK,
        },
      },
    },
    {
      submitter: {
        type: TxSubmitterType.TIMELOCK_CONTROLLER,
        chain: CHAIN_MOCK,
        timelockAddress: OWNER_ADDRESS_MOCK,
        // It should be transformed to a bigint and not fail parsing
        delay: 10 as any,
        proposerSubmitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN_MOCK,
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

  describe(TxSubmitterType.ACCESS_MANAGER, () => {
    const ACCESS_MANAGER_MOCK: Address =
      '0x3D079E977d644c914a344Dcb5Ba54dB243Cc4863';
    const REFUND_ADDRESS_MOCK: Address =
      '0x00000000000000000000000000000000000000AA';

    function parseSubmitter(input: unknown) {
      const result = ChainSubmissionStrategySchema.safeParse(input);
      assert(result.success, 'Expected parsing to succeed');
      return result.data;
    }

    it(`should default the chain from the key and the proposerSubmitter to ${TxSubmitterType.JSON_RPC}`, () => {
      const data = parseSubmitter({
        [CHAIN_MOCK]: {
          submitter: {
            type: TxSubmitterType.ACCESS_MANAGER,
            accessManagerAddress: ACCESS_MANAGER_MOCK,
          },
        },
      });

      const { submitter } = data[CHAIN_MOCK];
      assert(
        submitter.type === TxSubmitterType.ACCESS_MANAGER,
        `Expected ${TxSubmitterType.ACCESS_MANAGER}`,
      );
      expect(submitter.chain).to.equal(CHAIN_MOCK);
      expect(submitter.caller).to.be.undefined;
      expect(submitter.proposerSubmitter).to.deep.equal({
        type: TxSubmitterType.JSON_RPC,
        chain: CHAIN_MOCK,
      });
    });

    it('should default the proposerSubmitter chain to the AccessManager chain', () => {
      const data = parseSubmitter({
        [DESTINATION_CHAIN_MOCK]: {
          submitter: {
            type: TxSubmitterType.ACCESS_MANAGER,
            chain: CHAIN_MOCK,
            accessManagerAddress: ACCESS_MANAGER_MOCK,
            caller: ADDRESS_MOCK,
            proposerSubmitter: {
              type: TxSubmitterType.GNOSIS_TX_BUILDER,
              safeAddress: ADDRESS_MOCK,
              version: VERSION_MOCK,
            },
          },
        },
      });

      const { submitter } = data[DESTINATION_CHAIN_MOCK];
      assert(
        submitter.type === TxSubmitterType.ACCESS_MANAGER,
        `Expected ${TxSubmitterType.ACCESS_MANAGER}`,
      );
      expect(submitter.chain).to.equal(CHAIN_MOCK);
      expect(submitter.caller).to.equal(ADDRESS_MOCK);
      expect(submitter.proposerSubmitter.type).to.equal(
        TxSubmitterType.GNOSIS_TX_BUILDER,
      );
      expect(submitter.proposerSubmitter.chain).to.equal(CHAIN_MOCK);
    });

    it('should default the destinationChain of an interchain account proposer without overwriting its origin chain', () => {
      const data = parseSubmitter({
        [CHAIN_MOCK]: {
          submitter: {
            type: TxSubmitterType.ACCESS_MANAGER,
            accessManagerAddress: ACCESS_MANAGER_MOCK,
            proposerSubmitter: {
              type: TxSubmitterType.INTERCHAIN_ACCOUNT,
              chain: DESTINATION_CHAIN_MOCK,
              owner: OWNER_ADDRESS_MOCK,
            },
          },
        },
      });

      const { submitter } = data[CHAIN_MOCK];
      assert(
        submitter.type === TxSubmitterType.ACCESS_MANAGER,
        `Expected ${TxSubmitterType.ACCESS_MANAGER}`,
      );
      const { proposerSubmitter } = submitter;
      assert(
        proposerSubmitter.type === TxSubmitterType.INTERCHAIN_ACCOUNT,
        `Expected ${TxSubmitterType.INTERCHAIN_ACCOUNT}`,
      );
      expect(proposerSubmitter.chain).to.equal(DESTINATION_CHAIN_MOCK);
      expect(proposerSubmitter.destinationChain).to.equal(CHAIN_MOCK);
      expect(proposerSubmitter.internalSubmitter).to.deep.equal({
        type: TxSubmitterType.JSON_RPC,
        chain: DESTINATION_CHAIN_MOCK,
      });
    });

    describe(`as the internal submitter of an ${TxSubmitterType.INTERCHAIN_ACCOUNT}`, () => {
      function buildIcaStrategy(icaFields: {
        owner?: Address;
        refundAddress?: Address;
      }) {
        return {
          [DESTINATION_CHAIN_MOCK]: {
            submitter: {
              type: TxSubmitterType.INTERCHAIN_ACCOUNT,
              chain: CHAIN_MOCK,
              owner: icaFields.owner,
              refundAddress: icaFields.refundAddress,
              internalSubmitter: {
                type: TxSubmitterType.ACCESS_MANAGER,
                accessManagerAddress: ACCESS_MANAGER_MOCK,
              },
            },
          },
        };
      }

      it('should default the owner to the AccessManager address and the AccessManager chain to the origin chain', () => {
        const data = parseSubmitter(
          buildIcaStrategy({ refundAddress: REFUND_ADDRESS_MOCK }),
        );

        const { submitter } = data[DESTINATION_CHAIN_MOCK];
        assert(
          submitter.type === TxSubmitterType.INTERCHAIN_ACCOUNT,
          `Expected ${TxSubmitterType.INTERCHAIN_ACCOUNT}`,
        );
        expect(submitter.owner).to.equal(ACCESS_MANAGER_MOCK);
        expect(submitter.refundAddress).to.equal(REFUND_ADDRESS_MOCK);
        expect(submitter.destinationChain).to.equal(DESTINATION_CHAIN_MOCK);
        const { internalSubmitter } = submitter;
        assert(
          internalSubmitter.type === TxSubmitterType.ACCESS_MANAGER,
          `Expected ${TxSubmitterType.ACCESS_MANAGER}`,
        );
        expect(internalSubmitter.chain).to.equal(CHAIN_MOCK);
        expect(internalSubmitter.proposerSubmitter).to.deep.equal({
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN_MOCK,
        });
      });

      const invalidCases: Array<{
        name: string;
        icaFields: { owner?: Address; refundAddress?: Address };
        expectedMessage: string;
      }> = [
        {
          name: 'the owner does not match the AccessManager address',
          icaFields: {
            owner: OWNER_ADDRESS_MOCK,
            refundAddress: REFUND_ADDRESS_MOCK,
          },
          expectedMessage: `Interchain account owner address and AccessManager address must match for ${DESTINATION_CHAIN_MOCK}`,
        },
        {
          name: 'the refundAddress is missing',
          icaFields: {},
          expectedMessage: `Interchain account refundAddress must be set to an address other than the AccessManager for ${DESTINATION_CHAIN_MOCK}`,
        },
        {
          name: 'the refundAddress is the AccessManager address',
          icaFields: { refundAddress: ACCESS_MANAGER_MOCK.toLowerCase() },
          expectedMessage: `Interchain account refundAddress must be set to an address other than the AccessManager for ${DESTINATION_CHAIN_MOCK}`,
        },
      ];

      for (const { name, icaFields, expectedMessage } of invalidCases) {
        it(`should fail validation when ${name}`, () => {
          const result = ChainSubmissionStrategySchema.safeParse(
            buildIcaStrategy(icaFields),
          );
          expect(result.success).to.be.false;
          assert(!result.success, 'Expected parsing to fail');
          expect(
            result.error.issues.map(({ message }) => message),
          ).to.deep.equal([expectedMessage]);
        });
      }

      it('should pass validation when the owner is the AccessManager and the refundAddress differs from it', () => {
        const result = ChainSubmissionStrategySchema.safeParse(
          buildIcaStrategy({
            owner: ACCESS_MANAGER_MOCK.toLowerCase(),
            refundAddress: REFUND_ADDRESS_MOCK,
          }),
        );
        expect(result.success).to.be.true;
      });
    });

    describe(`with a nested ${TxSubmitterType.INTERCHAIN_ACCOUNT}`, () => {
      const OUTER_ACCESS_MANAGER_MOCK: Address =
        '0x00000000000000000000000000000000000000EE';
      const TIMELOCK_MOCK: Address =
        '0x00000000000000000000000000000000000000DD';

      interface NestedIcaCase {
        name: string;
        submitter: unknown;
        expectedIssues: string[];
      }

      function buildNestedIca(
        icaFields: { owner?: Address; refundAddress?: Address },
        internalSubmitter: unknown,
      ) {
        return {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT,
          chain: CHAIN_MOCK,
          owner: icaFields.owner,
          refundAddress: icaFields.refundAddress,
          internalSubmitter,
        };
      }

      function wrapInAccessManager(proposerSubmitter: unknown) {
        return {
          type: TxSubmitterType.ACCESS_MANAGER,
          accessManagerAddress: OUTER_ACCESS_MANAGER_MOCK,
          proposerSubmitter,
        };
      }

      const innerAccessManager = {
        type: TxSubmitterType.ACCESS_MANAGER,
        accessManagerAddress: ACCESS_MANAGER_MOCK,
      };

      const refundAddressIssue = `Interchain account refundAddress must be set to an address other than the AccessManager for ${DESTINATION_CHAIN_MOCK}`;

      const cases: NestedIcaCase[] = [
        {
          name: `a valid ${TxSubmitterType.ACCESS_MANAGER} internal submitter under an ${TxSubmitterType.ACCESS_MANAGER} proposer`,
          submitter: wrapInAccessManager(
            buildNestedIca(
              { refundAddress: REFUND_ADDRESS_MOCK },
              innerAccessManager,
            ),
          ),
          expectedIssues: [],
        },
        {
          name: `a missing refundAddress under an ${TxSubmitterType.ACCESS_MANAGER} proposer`,
          submitter: wrapInAccessManager(
            buildNestedIca({}, innerAccessManager),
          ),
          expectedIssues: [refundAddressIssue],
        },
        {
          name: `a refundAddress equal to the AccessManager under an ${TxSubmitterType.ACCESS_MANAGER} proposer`,
          submitter: wrapInAccessManager(
            buildNestedIca(
              { refundAddress: ACCESS_MANAGER_MOCK.toLowerCase() },
              innerAccessManager,
            ),
          ),
          expectedIssues: [refundAddressIssue],
        },
        {
          name: `an owner not matching the AccessManager under an ${TxSubmitterType.ACCESS_MANAGER} proposer`,
          submitter: wrapInAccessManager(
            buildNestedIca(
              {
                owner: OWNER_ADDRESS_MOCK,
                refundAddress: REFUND_ADDRESS_MOCK,
              },
              innerAccessManager,
            ),
          ),
          expectedIssues: [
            `Interchain account owner address and AccessManager address must match for ${DESTINATION_CHAIN_MOCK}`,
          ],
        },
        {
          name: `an owner not matching the multisig under an ${TxSubmitterType.ACCESS_MANAGER} proposer`,
          submitter: wrapInAccessManager(
            buildNestedIca(
              { owner: OWNER_ADDRESS_MOCK },
              {
                type: TxSubmitterType.GNOSIS_SAFE,
                safeAddress: ADDRESS_MOCK,
              },
            ),
          ),
          expectedIssues: [
            `Interchain account owner address and multisig address must match for ${DESTINATION_CHAIN_MOCK}`,
          ],
        },
        {
          name: `a missing refundAddress under a ${TxSubmitterType.TIMELOCK_CONTROLLER} proposer`,
          submitter: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            timelockAddress: TIMELOCK_MOCK,
            proposerSubmitter: buildNestedIca({}, innerAccessManager),
          },
          expectedIssues: [refundAddressIssue],
        },
        {
          name: `a missing refundAddress under an ${TxSubmitterType.INTERCHAIN_ACCOUNT} internal submitter`,
          submitter: buildNestedIca(
            { owner: OWNER_ADDRESS_MOCK },
            buildNestedIca({}, innerAccessManager),
          ),
          expectedIssues: [refundAddressIssue],
        },
      ];

      for (const { name, submitter, expectedIssues } of cases) {
        it(`should ${expectedIssues.length > 0 ? 'reject' : 'accept'} ${name}`, () => {
          const result = ChainSubmissionStrategySchema.safeParse({
            [DESTINATION_CHAIN_MOCK]: { submitter },
          });
          const issues = result.success
            ? []
            : result.error.issues.map(({ message }) => message);
          expect(issues).to.deep.equal(expectedIssues);
        });
      }
    });

    describe('caller validation', () => {
      const CALLER_MOCK: Address = '0x00000000000000000000000000000000000000Cc';
      const TIMELOCK_MOCK: Address =
        '0x00000000000000000000000000000000000000DD';

      interface CallerCase {
        name: string;
        submitter: unknown;
        expectedIssues: string[];
      }

      function buildAccessManager(
        caller: Address | undefined,
        proposerSubmitter: unknown,
        accessManagerAddress: Address = ACCESS_MANAGER_MOCK,
      ) {
        return {
          type: TxSubmitterType.ACCESS_MANAGER,
          chain: CHAIN_MOCK,
          accessManagerAddress,
          caller,
          proposerSubmitter,
        };
      }

      const safeProposer = {
        type: TxSubmitterType.GNOSIS_SAFE,
        safeAddress: ADDRESS_MOCK,
      };

      const INNER_ACCESS_MANAGER_MOCK: Address =
        '0x00000000000000000000000000000000000000Ee';
      const innerAccessManagerProposer = buildAccessManager(
        ADDRESS_MOCK,
        safeProposer,
        INNER_ACCESS_MANAGER_MOCK,
      );

      const cases: CallerCase[] = [
        {
          name: `${TxSubmitterType.GNOSIS_SAFE} proposer with a matching caller`,
          submitter: buildAccessManager(
            ADDRESS_MOCK.toLowerCase(),
            safeProposer,
          ),
          expectedIssues: [],
        },
        {
          name: `${TxSubmitterType.GNOSIS_SAFE} proposer with a mismatching caller`,
          submitter: buildAccessManager(CALLER_MOCK, safeProposer),
          expectedIssues: [
            `AccessManager caller ${CALLER_MOCK} must match the multisig address ${ADDRESS_MOCK} for ${CHAIN_MOCK}`,
          ],
        },
        {
          name: `${TxSubmitterType.GNOSIS_TX_BUILDER} proposer with a matching caller`,
          submitter: buildAccessManager(ADDRESS_MOCK, {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            safeAddress: ADDRESS_MOCK,
            version: VERSION_MOCK,
          }),
          expectedIssues: [],
        },
        {
          name: `${TxSubmitterType.GNOSIS_TX_BUILDER} proposer with a mismatching caller`,
          submitter: buildAccessManager(CALLER_MOCK, {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            safeAddress: ADDRESS_MOCK,
            version: VERSION_MOCK,
          }),
          expectedIssues: [
            `AccessManager caller ${CALLER_MOCK} must match the multisig address ${ADDRESS_MOCK} for ${CHAIN_MOCK}`,
          ],
        },
        {
          name: `${TxSubmitterType.TIMELOCK_CONTROLLER} proposer with a matching caller`,
          submitter: buildAccessManager(TIMELOCK_MOCK, {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            timelockAddress: TIMELOCK_MOCK,
          }),
          expectedIssues: [],
        },
        {
          name: `${TxSubmitterType.TIMELOCK_CONTROLLER} proposer with a mismatching caller`,
          submitter: buildAccessManager(CALLER_MOCK, {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            timelockAddress: TIMELOCK_MOCK,
          }),
          expectedIssues: [
            `AccessManager caller ${CALLER_MOCK} must match the timelock address ${TIMELOCK_MOCK} for ${CHAIN_MOCK}`,
          ],
        },
        {
          name: `${TxSubmitterType.JSON_RPC} proposer with a matching userAddress`,
          submitter: buildAccessManager(ADDRESS_MOCK, {
            type: TxSubmitterType.JSON_RPC,
            userAddress: ADDRESS_MOCK,
          }),
          expectedIssues: [],
        },
        {
          name: `${TxSubmitterType.JSON_RPC} proposer with a mismatching userAddress`,
          submitter: buildAccessManager(CALLER_MOCK, {
            type: TxSubmitterType.JSON_RPC,
            userAddress: ADDRESS_MOCK,
          }),
          expectedIssues: [
            `AccessManager caller ${CALLER_MOCK} must match the jsonRpc user address ${ADDRESS_MOCK} for ${CHAIN_MOCK}`,
          ],
        },
        {
          name: `${TxSubmitterType.JSON_RPC} proposer without a userAddress`,
          submitter: buildAccessManager(CALLER_MOCK, {
            type: TxSubmitterType.JSON_RPC,
          }),
          expectedIssues: [],
        },
        {
          name: `${TxSubmitterType.INTERCHAIN_ACCOUNT} proposer`,
          submitter: buildAccessManager(CALLER_MOCK, {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: DESTINATION_CHAIN_MOCK,
            owner: ADDRESS_MOCK,
          }),
          expectedIssues: [],
        },
        {
          name: 'an AccessManager without a caller',
          submitter: buildAccessManager(undefined, safeProposer),
          expectedIssues: [],
        },
        {
          name: `${TxSubmitterType.INTERCHAIN_ACCOUNT} internal submitter with a mismatching caller`,
          submitter: {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: CHAIN_MOCK,
            owner: ACCESS_MANAGER_MOCK,
            refundAddress: REFUND_ADDRESS_MOCK,
            internalSubmitter: buildAccessManager(CALLER_MOCK, safeProposer),
          },
          expectedIssues: [
            `AccessManager caller ${CALLER_MOCK} must match the multisig address ${ADDRESS_MOCK} for ${CHAIN_MOCK}`,
          ],
        },
        {
          name: `${TxSubmitterType.INTERCHAIN_ACCOUNT} internal submitter with a mismatching caller and no refundAddress`,
          submitter: {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: CHAIN_MOCK,
            owner: ACCESS_MANAGER_MOCK,
            internalSubmitter: buildAccessManager(CALLER_MOCK, safeProposer),
          },
          expectedIssues: [
            `AccessManager caller ${CALLER_MOCK} must match the multisig address ${ADDRESS_MOCK} for ${CHAIN_MOCK}`,
            `Interchain account refundAddress must be set to an address other than the AccessManager for ${CHAIN_MOCK}`,
          ],
        },
        {
          name: `${TxSubmitterType.TIMELOCK_CONTROLLER} proposer submitter with a mismatching caller`,
          submitter: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: CHAIN_MOCK,
            timelockAddress: TIMELOCK_MOCK,
            proposerSubmitter: buildAccessManager(CALLER_MOCK, safeProposer),
          },
          expectedIssues: [
            `AccessManager caller ${CALLER_MOCK} must match the multisig address ${ADDRESS_MOCK} for ${CHAIN_MOCK}`,
          ],
        },
        {
          name: `${TxSubmitterType.ACCESS_MANAGER} proposer submitter with a mismatching caller`,
          submitter: buildAccessManager(
            undefined,
            buildAccessManager(CALLER_MOCK, safeProposer),
          ),
          expectedIssues: [
            `AccessManager caller ${CALLER_MOCK} must match the multisig address ${ADDRESS_MOCK} for ${CHAIN_MOCK}`,
          ],
        },
        {
          name: `${TxSubmitterType.ACCESS_MANAGER} proposer with a caller matching its address`,
          submitter: buildAccessManager(
            INNER_ACCESS_MANAGER_MOCK.toLowerCase(),
            innerAccessManagerProposer,
          ),
          expectedIssues: [],
        },
        {
          name: `${TxSubmitterType.ACCESS_MANAGER} proposer with a caller not matching its address`,
          submitter: buildAccessManager(
            CALLER_MOCK,
            innerAccessManagerProposer,
          ),
          expectedIssues: [
            `AccessManager caller ${CALLER_MOCK} must match the AccessManager address ${INNER_ACCESS_MANAGER_MOCK} for ${CHAIN_MOCK}`,
          ],
        },
      ];

      for (const { name, submitter, expectedIssues } of cases) {
        it(`should ${expectedIssues.length > 0 ? 'reject' : 'accept'} ${name}`, () => {
          const result = ChainSubmissionStrategySchema.safeParse({
            [CHAIN_MOCK]: { submitter },
          });
          const issues = result.success
            ? []
            : result.error.issues.map(({ message }) => message);
          expect(issues).to.deep.equal(expectedIssues);
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
