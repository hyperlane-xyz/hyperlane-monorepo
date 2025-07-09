import { expect } from 'chai';

import {
  AggregationIsmConfig,
  AggregationIsmConfigSchema,
  ArbL2ToL1IsmConfigSchema,
  CCIPIsmConfig,
  CCIPIsmConfigSchema,
  InterchainAccountRouterIsm,
  InterchainAccountRouterIsmSchema,
  IsmConfig,
  IsmConfigSchema,
  IsmType,
  MultisigIsmConfig,
  MultisigIsmConfigSchema,
  OffchainLookupIsmConfig,
  OffchainLookupIsmConfigSchema,
  OpStackIsmConfig,
  OpStackIsmConfigSchema,
  PausableIsmConfig,
  PausableIsmConfigSchema,
  TestIsmConfig,
  TestIsmConfigSchema,
  TrustedRelayerIsmConfig,
  TrustedRelayerIsmConfigSchema,
  WeightedMultisigIsmConfig,
  WeightedMultisigIsmConfigSchema,
} from './types.js';

describe('ISM schemas', () => {
  type TestCase<T> = {
    name: string;
    input: T;
  };

  describe('TestIsmConfigSchema', () => {
    const validTestCases: TestCase<TestIsmConfig>[] = [
      {
        name: 'minimal test ISM',
        input: {
          type: IsmType.TEST_ISM,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(TestIsmConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<TestIsmConfig>>[] = [
      {
        name: 'missing type',
        input: {},
      },
      {
        name: 'wrong type',
        input: {
          type: IsmType.MERKLE_ROOT_MULTISIG as IsmType.TEST_ISM,
        },
      },
      {
        name: 'invalid type value',
        input: {
          type: 'invalidType' as IsmType.TEST_ISM,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(TestIsmConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('MultisigIsmConfigSchema', () => {
    const validTestCases: TestCase<MultisigIsmConfig>[] = [
      {
        name: 'merkle root multisig ISM',
        input: {
          type: IsmType.MERKLE_ROOT_MULTISIG,
          validators: ['0x1234567890123456789012345678901234567890'],
          threshold: 1,
        },
      },
      {
        name: 'message ID multisig ISM',
        input: {
          type: IsmType.MESSAGE_ID_MULTISIG,
          validators: [
            '0x1234567890123456789012345678901234567890',
            '0x2345678901234567890123456789012345678901',
          ],
          threshold: 2,
        },
      },
      {
        name: 'storage merkle root multisig ISM',
        input: {
          type: IsmType.STORAGE_MERKLE_ROOT_MULTISIG,
          validators: [
            '0x1234567890123456789012345678901234567890',
            '0x2345678901234567890123456789012345678901',
            '0x3456789012345678901234567890123456789012',
          ],
          threshold: 2,
        },
      },
      {
        name: 'storage message ID multisig ISM',
        input: {
          type: IsmType.STORAGE_MESSAGE_ID_MULTISIG,
          validators: [
            '0x1234567890123456789012345678901234567890',
            '0x2345678901234567890123456789012345678901',
          ],
          threshold: 1,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(MultisigIsmConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<MultisigIsmConfig>>[] = [
      {
        name: 'missing validators',
        input: {
          type: IsmType.MERKLE_ROOT_MULTISIG,
          threshold: 1,
        },
      },
      {
        name: 'missing threshold',
        input: {
          type: IsmType.MERKLE_ROOT_MULTISIG,
          validators: ['0x1234567890123456789012345678901234567890'],
        },
      },
      {
        name: 'empty validators array',
        input: {
          type: IsmType.MERKLE_ROOT_MULTISIG,
          validators: [],
          threshold: 1,
        },
      },
      {
        name: 'wrong type',
        input: {
          type: IsmType.TEST_ISM as IsmType.MERKLE_ROOT_MULTISIG,
          validators: ['0x1234567890123456789012345678901234567890'],
          threshold: 1,
        },
      },
      {
        name: 'non-number threshold',
        input: {
          type: IsmType.MERKLE_ROOT_MULTISIG,
          validators: ['0x1234567890123456789012345678901234567890'],
          threshold: '1' as unknown as number,
        },
      },
      {
        name: 'zero threshold',
        input: {
          type: IsmType.MERKLE_ROOT_MULTISIG,
          validators: ['0x1234567890123456789012345678901234567890'],
          threshold: 0,
        },
      },
      {
        name: 'negative threshold',
        input: {
          type: IsmType.MERKLE_ROOT_MULTISIG,
          validators: ['0x1234567890123456789012345678901234567890'],
          threshold: -1,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(MultisigIsmConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('WeightedMultisigIsmConfigSchema', () => {
    const validTestCases: TestCase<WeightedMultisigIsmConfig>[] = [
      {
        name: 'weighted merkle root multisig ISM',
        input: {
          type: IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG,
          validators: [
            {
              signingAddress: '0x1234567890123456789012345678901234567890',
              weight: 1,
            },
          ],
          thresholdWeight: 1,
        },
      },
      {
        name: 'weighted message ID multisig ISM',
        input: {
          type: IsmType.WEIGHTED_MESSAGE_ID_MULTISIG,
          validators: [
            {
              signingAddress: '0x1234567890123456789012345678901234567890',
              weight: 2,
            },
            {
              signingAddress: '0x2345678901234567890123456789012345678901',
              weight: 3,
            },
          ],
          thresholdWeight: 3,
        },
      },
      {
        name: 'weighted multisig with multiple validators',
        input: {
          type: IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG,
          validators: [
            {
              signingAddress: '0x1234567890123456789012345678901234567890',
              weight: 1,
            },
            {
              signingAddress: '0x2345678901234567890123456789012345678901',
              weight: 2,
            },
            {
              signingAddress: '0x3456789012345678901234567890123456789012',
              weight: 3,
            },
          ],
          thresholdWeight: 4,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(WeightedMultisigIsmConfigSchema.safeParse(input).success).to.be
          .true;
      });
    });

    const invalidTestCases: TestCase<Partial<WeightedMultisigIsmConfig>>[] = [
      {
        name: 'missing validators',
        input: {
          type: IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG,
          thresholdWeight: 1,
        },
      },
      {
        name: 'missing thresholdWeight',
        input: {
          type: IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG,
          validators: [
            {
              signingAddress: '0x1234567890123456789012345678901234567890',
              weight: 1,
            },
          ],
        },
      },
      {
        name: 'validator missing weight',
        input: {
          type: IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG,
          validators: [
            {
              weight: undefined as any,
              signingAddress: '0x1234567890123456789012345678901234567890',
            },
          ],
          thresholdWeight: 1,
        },
      },
      {
        name: 'validator missing signingAddress',
        input: {
          type: IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG,
          validators: [
            {
              weight: 1,
              signingAddress: undefined as any,
            },
          ],
          thresholdWeight: 1,
        },
      },
      {
        name: 'zero weight',
        input: {
          type: IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG,
          validators: [
            {
              signingAddress: '0x1234567890123456789012345678901234567890',
              weight: 0,
            },
          ],
          thresholdWeight: 1,
        },
      },
      {
        name: 'negative weight',
        input: {
          type: IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG,
          validators: [
            {
              signingAddress: '0x1234567890123456789012345678901234567890',
              weight: -1,
            },
          ],
          thresholdWeight: 1,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(WeightedMultisigIsmConfigSchema.safeParse(input).success).to.be
          .false;
      });
    });
  });

  describe('PausableIsmConfigSchema', () => {
    const validTestCases: TestCase<PausableIsmConfig>[] = [
      {
        name: 'pausable ISM with owner',
        input: {
          type: IsmType.PAUSABLE,
          owner: '0x1234567890123456789012345678901234567890',
          paused: false,
        },
      },
      {
        name: 'pausable ISM paused',
        input: {
          type: IsmType.PAUSABLE,
          owner: '0x1234567890123456789012345678901234567890',
          paused: true,
        },
      },
      {
        name: 'pausable ISM not paused',
        input: {
          type: IsmType.PAUSABLE,
          owner: '0x1234567890123456789012345678901234567890',
          paused: false,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(PausableIsmConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<PausableIsmConfig>>[] = [
      {
        name: 'missing owner',
        input: {
          type: IsmType.PAUSABLE,
        },
      },
      {
        name: 'empty owner',
        input: {
          type: IsmType.PAUSABLE,
          owner: '',
        },
      },
      // Type assert to cause validation errrors
      {
        name: 'wrong type',
        input: {
          type: IsmType.TEST_ISM as IsmType.PAUSABLE,
          owner: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'non-boolean paused',
        input: {
          type: IsmType.PAUSABLE,
          owner: '0x1234567890123456789012345678901234567890',
          paused: 'true' as any,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(PausableIsmConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('TrustedRelayerIsmConfigSchema', () => {
    const validTestCases: TestCase<TrustedRelayerIsmConfig>[] = [
      {
        name: 'trusted relayer ISM',
        input: {
          type: IsmType.TRUSTED_RELAYER,
          relayer: '0x1234567890123456789012345678901234567890',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(TrustedRelayerIsmConfigSchema.safeParse(input).success).to.be
          .true;
      });
    });

    const invalidTestCases: TestCase<Partial<TrustedRelayerIsmConfig>>[] = [
      {
        name: 'missing relayer',
        input: {
          type: IsmType.TRUSTED_RELAYER,
        },
      },
      {
        name: 'empty relayer',
        input: {
          type: IsmType.TRUSTED_RELAYER,
          relayer: '',
        },
      },
      // Type asserting to cause validation errors
      {
        name: 'wrong type',
        input: {
          type: IsmType.TEST_ISM as IsmType.TRUSTED_RELAYER,
          relayer: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'non-string relayer',
        input: {
          type: IsmType.TRUSTED_RELAYER,
          relayer: 123 as any,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(TrustedRelayerIsmConfigSchema.safeParse(input).success).to.be
          .false;
      });
    });
  });

  describe('CCIPIsmConfigSchema', () => {
    const validTestCases: TestCase<CCIPIsmConfig>[] = [
      {
        name: 'CCIP ISM',
        input: {
          type: IsmType.CCIP,
          originChain: 'ethereum',
        },
      },
      {
        name: 'CCIP ISM with different chain',
        input: {
          type: IsmType.CCIP,
          originChain: 'arbitrum',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(CCIPIsmConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<CCIPIsmConfig>>[] = [
      {
        name: 'missing originChain',
        input: {
          type: IsmType.CCIP,
        },
      },
      {
        name: 'empty originChain',
        input: {
          type: IsmType.CCIP,
          originChain: '',
        },
      },
      // Type asserting to cause validation errors
      {
        name: 'wrong type',
        input: {
          type: IsmType.TEST_ISM as IsmType.CCIP,
          originChain: 'ethereum',
        },
      },
      {
        name: 'non-string originChain',
        input: {
          type: IsmType.CCIP,
          originChain: 123 as any,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(CCIPIsmConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('OpStackIsmConfigSchema', () => {
    const validTestCases: TestCase<OpStackIsmConfig>[] = [
      {
        name: 'OP Stack ISM',
        input: {
          type: IsmType.OP_STACK,
          origin: 'ethereum',
          nativeBridge: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'OP Stack ISM with different origin',
        input: {
          type: IsmType.OP_STACK,
          origin: 'optimism',
          nativeBridge: '0x2345678901234567890123456789012345678901',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(OpStackIsmConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<OpStackIsmConfig>>[] = [
      {
        name: 'missing origin',
        input: {
          type: IsmType.OP_STACK,
          nativeBridge: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'missing nativeBridge',
        input: {
          type: IsmType.OP_STACK,
          origin: 'ethereum',
        },
      },
      {
        name: 'wrong type',
        input: {
          type: IsmType.TEST_ISM as any,
          origin: 'ethereum',
          nativeBridge: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'empty origin',
        input: {
          type: IsmType.OP_STACK,
          origin: '',
          nativeBridge: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'empty nativeBridge',
        input: {
          type: IsmType.OP_STACK,
          origin: 'ethereum',
          nativeBridge: '',
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(OpStackIsmConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('ArbL2ToL1IsmConfigSchema', () => {
    const validTestCases: TestCase<{
      type: IsmType.ARB_L2_TO_L1;
      bridge: string;
    }>[] = [
      {
        name: 'Arbitrum L2 to L1 ISM',
        input: {
          type: IsmType.ARB_L2_TO_L1,
          bridge: '0x1234567890123456789012345678901234567890',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(ArbL2ToL1IsmConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'missing bridge',
        input: {
          type: IsmType.ARB_L2_TO_L1,
        },
      },
      {
        name: 'wrong type',
        input: {
          type: IsmType.TEST_ISM,
          bridge: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'empty bridge',
        input: {
          type: IsmType.ARB_L2_TO_L1,
          bridge: '',
        },
      },
      {
        name: 'non-string bridge',
        input: {
          type: IsmType.ARB_L2_TO_L1,
          bridge: 123,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(ArbL2ToL1IsmConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('OffchainLookupIsmConfigSchema', () => {
    const validTestCases: TestCase<OffchainLookupIsmConfig>[] = [
      {
        name: 'offchain lookup ISM',
        input: {
          type: IsmType.OFFCHAIN_LOOKUP,
          owner: '0x1234567890123456789012345678901234567890',
          urls: ['https://example.com'],
        },
      },
      {
        name: 'offchain lookup ISM with multiple URLs',
        input: {
          type: IsmType.OFFCHAIN_LOOKUP,
          owner: '0x1234567890123456789012345678901234567890',
          urls: ['https://example.com', 'https://backup.com'],
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(OffchainLookupIsmConfigSchema.safeParse(input).success).to.be
          .true;
      });
    });

    const invalidTestCases: TestCase<Partial<OffchainLookupIsmConfig>>[] = [
      {
        name: 'missing owner',
        input: {
          type: IsmType.OFFCHAIN_LOOKUP,
          urls: ['https://example.com'],
        },
      },
      {
        name: 'missing urls',
        input: {
          type: IsmType.OFFCHAIN_LOOKUP,
          owner: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'empty urls array',
        input: {
          type: IsmType.OFFCHAIN_LOOKUP,
          owner: '0x1234567890123456789012345678901234567890',
          urls: [],
        },
      },
      {
        name: 'wrong type',
        input: {
          type: IsmType.TEST_ISM as any,
          owner: '0x1234567890123456789012345678901234567890',
          urls: ['https://example.com'],
        },
      },
      {
        name: 'empty owner',
        input: {
          type: IsmType.OFFCHAIN_LOOKUP,
          owner: '',
          urls: ['https://example.com'],
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(OffchainLookupIsmConfigSchema.safeParse(input).success).to.be
          .false;
      });
    });
  });

  describe('InterchainAccountRouterIsmSchema', () => {
    const validTestCases: TestCase<InterchainAccountRouterIsm>[] = [
      {
        name: 'interchain account router ISM',
        input: {
          type: IsmType.INTERCHAIN_ACCOUNT_ROUTING,
          owner: '0x1234567890123456789012345678901234567890',
          isms: {
            ethereum: '0x1234567890123456789012345678901234567890',
          },
        },
      },
      {
        name: 'interchain account router ISM with multiple ISMs',
        input: {
          type: IsmType.INTERCHAIN_ACCOUNT_ROUTING,
          owner: '0x1234567890123456789012345678901234567890',
          isms: {
            ethereum: '0x1234567890123456789012345678901234567890',
            arbitrum: '0x2345678901234567890123456789012345678901',
            optimism: '0x3456789012345678901234567890123456789012',
          },
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(InterchainAccountRouterIsmSchema.safeParse(input).success).to.be
          .true;
      });
    });

    const invalidTestCases: TestCase<Partial<InterchainAccountRouterIsm>>[] = [
      {
        name: 'missing owner',
        input: {
          type: IsmType.INTERCHAIN_ACCOUNT_ROUTING,
          isms: {
            ethereum: '0x1234567890123456789012345678901234567890',
          },
        },
      },
      {
        name: 'missing isms',
        input: {
          type: IsmType.INTERCHAIN_ACCOUNT_ROUTING,
          owner: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'wrong type',
        input: {
          type: IsmType.TEST_ISM as any,
          owner: '0x1234567890123456789012345678901234567890',
          isms: {
            ethereum: '0x1234567890123456789012345678901234567890',
          },
        },
      },
      {
        name: 'empty owner',
        input: {
          type: IsmType.INTERCHAIN_ACCOUNT_ROUTING,
          owner: '',
          isms: {
            ethereum: '0x1234567890123456789012345678901234567890',
          },
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(InterchainAccountRouterIsmSchema.safeParse(input).success).to.be
          .false;
      });
    });
  });

  describe('AggregationIsmConfigSchema', () => {
    const validTestCases: TestCase<AggregationIsmConfig>[] = [
      {
        name: 'aggregation ISM with single module',
        input: {
          type: IsmType.AGGREGATION,
          modules: [
            {
              type: IsmType.TEST_ISM,
            },
          ],
          threshold: 1,
        },
      },
      {
        name: 'aggregation ISM with multiple modules',
        input: {
          type: IsmType.AGGREGATION,
          modules: [
            {
              type: IsmType.TEST_ISM,
            },
            {
              type: IsmType.MERKLE_ROOT_MULTISIG,
              validators: ['0x1234567890123456789012345678901234567890'],
              threshold: 1,
            },
          ],
          threshold: 2,
        },
      },
      {
        name: 'aggregation ISM with threshold equal to modules length',
        input: {
          type: IsmType.AGGREGATION,
          modules: [
            {
              type: IsmType.TEST_ISM,
            },
            {
              type: IsmType.PAUSABLE,
              owner: '0x1234567890123456789012345678901234567890',
              paused: false,
            },
          ],
          threshold: 2,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(AggregationIsmConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<AggregationIsmConfig>>[] = [
      {
        name: 'missing modules',
        input: {
          type: IsmType.AGGREGATION,
          threshold: 1,
        },
      },
      {
        name: 'missing threshold',
        input: {
          type: IsmType.AGGREGATION,
          modules: [
            {
              type: IsmType.TEST_ISM,
            },
          ],
        },
      },
      {
        name: 'threshold greater than modules length',
        input: {
          type: IsmType.AGGREGATION,
          modules: [
            {
              type: IsmType.TEST_ISM,
            },
          ],
          threshold: 2,
        },
      },
      {
        name: 'empty modules array',
        input: {
          type: IsmType.AGGREGATION,
          modules: [],
          threshold: 1,
        },
      },
      {
        name: 'zero threshold',
        input: {
          type: IsmType.AGGREGATION,
          modules: [
            {
              type: IsmType.TEST_ISM,
            },
          ],
          threshold: 0,
        },
      },
      {
        name: 'negative threshold',
        input: {
          type: IsmType.AGGREGATION,
          modules: [
            {
              type: IsmType.TEST_ISM,
            },
          ],
          threshold: -1,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(AggregationIsmConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('IsmConfigSchema', () => {
    const validTestCases: TestCase<IsmConfig>[] = [
      {
        name: 'address string',
        input: '0x1234567890123456789012345678901234567890',
      },
      {
        name: 'test ISM',
        input: {
          type: IsmType.TEST_ISM,
        },
      },
      {
        name: 'multisig ISM',
        input: {
          type: IsmType.MERKLE_ROOT_MULTISIG,
          validators: ['0x1234567890123456789012345678901234567890'],
          threshold: 1,
        },
      },
      {
        name: 'aggregation ISM',
        input: {
          type: IsmType.AGGREGATION,
          modules: [
            {
              type: IsmType.TEST_ISM,
            },
          ],
          threshold: 1,
        },
      },
      {
        name: 'pausable ISM',
        input: {
          type: IsmType.PAUSABLE,
          owner: '0x1234567890123456789012345678901234567890',
          paused: false,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(IsmConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<IsmConfig>>[] = [
      {
        name: 'invalid address',
        input: 'not-an-address',
      },
      {
        name: 'invalid type',
        input: {
          type: 'invalidType' as any,
        },
      },
      {
        name: 'incomplete multisig',
        input: {
          type: IsmType.MERKLE_ROOT_MULTISIG,
          validators: ['0x1234567890123456789012345678901234567890'],
          // missing threshold
        },
      },
      {
        name: 'number instead of config',
        input: 123 as any,
      },
      {
        name: 'boolean instead of config',
        input: true,
      },
      {
        name: 'null input',
        input: null,
      },
      {
        name: 'undefined input',
        input: undefined,
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(IsmConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('Edge cases and schema composition', () => {
    it('should handle complex nested ISM configurations', () => {
      const complexISM = {
        type: IsmType.AGGREGATION,
        modules: [
          {
            type: IsmType.MERKLE_ROOT_MULTISIG,
            validators: [
              '0x1234567890123456789012345678901234567890',
              '0x2345678901234567890123456789012345678901',
            ],
            threshold: 2,
          },
          {
            type: IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG,
            validators: [
              {
                signingAddress: '0x1234567890123456789012345678901234567890',
                weight: 1,
              },
              {
                signingAddress: '0x2345678901234567890123456789012345678901',
                weight: 2,
              },
            ],
            thresholdWeight: 2,
          },
        ],
        threshold: 2,
      };

      expect(IsmConfigSchema.safeParse(complexISM).success).to.be.true;
    });

    it('should validate aggregation threshold constraint', () => {
      const invalidAggregation = {
        type: IsmType.AGGREGATION,
        modules: [
          {
            type: IsmType.TEST_ISM,
          },
        ],
        threshold: 2, // Greater than modules length
      };

      expect(AggregationIsmConfigSchema.safeParse(invalidAggregation).success)
        .to.be.false;
    });

    const testCases: Exclude<IsmConfig, string>[] = [
      { type: IsmType.TEST_ISM },
      {
        type: IsmType.MERKLE_ROOT_MULTISIG,
        validators: ['0x1234567890123456789012345678901234567890'],
        threshold: 1,
      },
      {
        type: IsmType.PAUSABLE,
        owner: '0x1234567890123456789012345678901234567890',
        paused: false,
      },
      {
        type: IsmType.TRUSTED_RELAYER,
        relayer: '0x1234567890123456789012345678901234567890',
      },
      {
        type: IsmType.CCIP,
        originChain: 'ethereum',
      },
      {
        type: IsmType.OP_STACK,
        origin: 'ethereum',
        nativeBridge: '0x1234567890123456789012345678901234567890',
      },
      {
        type: IsmType.ARB_L2_TO_L1,
        bridge: '0x1234567890123456789012345678901234567890',
      },
      {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: '0x1234567890123456789012345678901234567890',
        urls: ['https://example.com'],
      },
      {
        type: IsmType.INTERCHAIN_ACCOUNT_ROUTING,
        owner: '0x1234567890123456789012345678901234567890',
        isms: {
          ethereum: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        type: IsmType.AGGREGATION,
        modules: [{ type: IsmType.TEST_ISM }],
        threshold: 1,
      },
    ];

    testCases.forEach((testCase) => {
      it(`should handle ISM type ${testCase.type}`, () => {
        expect(IsmConfigSchema.safeParse(testCase).success).to.be.true;
      });
    });
  });
});
