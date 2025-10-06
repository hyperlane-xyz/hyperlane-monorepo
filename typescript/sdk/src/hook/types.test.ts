import { expect } from 'chai';

import {
  AggregationHookConfig,
  AggregationHookConfigSchema,
  AmountRoutingHookConfig,
  AmountRoutingHookConfigSchema,
  ArbL2ToL1HookConfig,
  ArbL2ToL1HookSchema,
  CCIPHookConfig,
  CCIPHookSchema,
  DomainRoutingHookConfig,
  DomainRoutingHookConfigSchema,
  FallbackRoutingHookConfig,
  FallbackRoutingHookConfigSchema,
  HookConfigSchema,
  HookType,
  IgpHookConfig,
  IgpSchema,
  MailboxDefaultHookConfig,
  MailboxDefaultHookSchema,
  MerkleTreeHookConfig,
  MerkleTreeSchema,
  OpStackHookConfig,
  OpStackHookSchema,
  PausableHookConfig,
  PausableHookSchema,
  ProtocolFeeHookConfig,
  ProtocolFeeSchema,
} from './types.js';

describe('Hook schemas', () => {
  type TestCase<T> = {
    name: string;
    input: T;
  };

  describe('MerkleTreeSchema', () => {
    const validTestCases: TestCase<MerkleTreeHookConfig>[] = [
      {
        name: 'minimal merkle tree hook',
        input: {
          type: HookType.MERKLE_TREE,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(MerkleTreeSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'missing type',
        input: {},
      },
      {
        name: 'wrong type',
        input: {
          type: HookType.PROTOCOL_FEE,
        },
      },
      {
        name: 'invalid type value',
        input: {
          type: 'invalidType',
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(MerkleTreeSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('IgpSchema', () => {
    const validTestCases: TestCase<IgpHookConfig>[] = [
      {
        name: 'minimal IGP hook',
        input: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x1234567890123456789012345678901234567890',
          oracleKey: '0x1234567890123456789012345678901234567890',
          overhead: {
            ethereum: 50000,
            arbitrum: 100000,
          },
          oracleConfig: {
            ethereum: {
              gasPrice: '20000000000',
              tokenExchangeRate: '10000000000',
            },
          },
        },
      },
      {
        name: 'IGP hook with different chains',
        input: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x2345678901234567890123456789012345678901',
          oracleKey: '0x3456789012345678901234567890123456789012',
          overhead: {
            ethereum: 50000,
            arbitrum: 100000,
            optimism: 75000,
          },
          oracleConfig: {
            ethereum: {
              gasPrice: '20000000000',
              tokenExchangeRate: '1000000000000000000',
            },
            arbitrum: {
              gasPrice: '1000000000',
              tokenExchangeRate: '1000000000000000000',
              tokenDecimals: 18,
            },
            optimism: {
              gasPrice: '1500000000',
              tokenExchangeRate: '1000000000000000000',
              typicalCost: {
                handleGasAmount: 50000,
                totalGasAmount: 100000,
                totalUsdCost: 0.5,
              },
            },
          },
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(IgpSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'missing owner',
        input: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          beneficiary: '0x1234567890123456789012345678901234567890',
          oracleKey: '0x1234567890123456789012345678901234567890',
          overhead: { ethereum: 50000 },
          oracleConfig: { ethereum: {} },
        },
      },
      {
        name: 'missing beneficiary',
        input: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: '0x1234567890123456789012345678901234567890',
          oracleKey: '0x1234567890123456789012345678901234567890',
          overhead: { ethereum: 50000 },
          oracleConfig: { ethereum: {} },
        },
      },
      {
        name: 'missing oracleKey',
        input: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x1234567890123456789012345678901234567890',
          overhead: { ethereum: 50000 },
          oracleConfig: { ethereum: {} },
        },
      },
      {
        name: 'missing overhead',
        input: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x1234567890123456789012345678901234567890',
          oracleKey: '0x1234567890123456789012345678901234567890',
          oracleConfig: { ethereum: {} },
        },
      },
      {
        name: 'missing oracleConfig',
        input: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x1234567890123456789012345678901234567890',
          oracleKey: '0x1234567890123456789012345678901234567890',
          overhead: { ethereum: 50000 },
        },
      },
      {
        name: 'wrong type',
        input: {
          type: HookType.MERKLE_TREE,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x1234567890123456789012345678901234567890',
          oracleKey: '0x1234567890123456789012345678901234567890',
          overhead: { ethereum: 50000 },
          oracleConfig: { ethereum: {} },
        },
      },
      {
        name: 'empty owner',
        input: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: '',
          beneficiary: '0x1234567890123456789012345678901234567890',
          oracleKey: '0x1234567890123456789012345678901234567890',
          overhead: { ethereum: 50000 },
          oracleConfig: { ethereum: {} },
        },
      },
      {
        name: 'non-number overhead value',
        input: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x1234567890123456789012345678901234567890',
          oracleKey: '0x1234567890123456789012345678901234567890',
          overhead: { ethereum: '50000' },
          oracleConfig: { ethereum: {} },
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(IgpSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('ProtocolFeeSchema', () => {
    const validTestCases: TestCase<ProtocolFeeHookConfig>[] = [
      {
        name: 'minimal protocol fee hook',
        input: {
          type: HookType.PROTOCOL_FEE,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x1234567890123456789012345678901234567890',
          maxProtocolFee: '1000000000000000000',
          protocolFee: '100000000000000000',
        },
      },
      {
        name: 'protocol fee hook with different values',
        input: {
          type: HookType.PROTOCOL_FEE,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x2345678901234567890123456789012345678901',
          maxProtocolFee: '5000000000000000000',
          protocolFee: '500000000000000000',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(ProtocolFeeSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<ProtocolFeeHookConfig>>[] = [
      {
        name: 'missing owner',
        input: {
          type: HookType.PROTOCOL_FEE,
          beneficiary: '0x1234567890123456789012345678901234567890',
          maxProtocolFee: '1000000000000000000',
          protocolFee: '100000000000000000',
        },
      },
      {
        name: 'missing beneficiary',
        input: {
          type: HookType.PROTOCOL_FEE,
          owner: '0x1234567890123456789012345678901234567890',
          maxProtocolFee: '1000000000000000000',
          protocolFee: '100000000000000000',
        },
      },
      {
        name: 'missing maxProtocolFee',
        input: {
          type: HookType.PROTOCOL_FEE,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x1234567890123456789012345678901234567890',
          protocolFee: '100000000000000000',
        },
      },
      {
        name: 'missing protocolFee',
        input: {
          type: HookType.PROTOCOL_FEE,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x1234567890123456789012345678901234567890',
          maxProtocolFee: '1000000000000000000',
        },
      },
      {
        name: 'wrong type',
        input: {
          type: HookType.MERKLE_TREE as HookType.PROTOCOL_FEE,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x1234567890123456789012345678901234567890',
          maxProtocolFee: '1000000000000000000',
          protocolFee: '100000000000000000',
        },
      },
      {
        name: 'empty owner',
        input: {
          type: HookType.PROTOCOL_FEE,
          owner: '',
          beneficiary: '0x1234567890123456789012345678901234567890',
          maxProtocolFee: '1000000000000000000',
          protocolFee: '100000000000000000',
        },
      },
      {
        name: 'non-string maxProtocolFee',
        input: {
          type: HookType.PROTOCOL_FEE,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x1234567890123456789012345678901234567890',
          maxProtocolFee: 1000000000000000000 as unknown as string,
          protocolFee: '100000000000000000',
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(ProtocolFeeSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('PausableHookSchema', () => {
    const validTestCases: TestCase<PausableHookConfig>[] = [
      {
        name: 'pausable hook with owner',
        input: {
          type: HookType.PAUSABLE,
          owner: '0x1234567890123456789012345678901234567890',
          paused: false,
        },
      },
      {
        name: 'pausable hook paused',
        input: {
          type: HookType.PAUSABLE,
          owner: '0x1234567890123456789012345678901234567890',
          paused: true,
        },
      },
      {
        name: 'pausable hook not paused',
        input: {
          type: HookType.PAUSABLE,
          owner: '0x1234567890123456789012345678901234567890',
          paused: false,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(PausableHookSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'missing owner',
        input: {
          type: HookType.PAUSABLE,
          paused: false,
        },
      },
      {
        name: 'missing paused',
        input: {
          type: HookType.PAUSABLE,
          owner: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'wrong type',
        input: {
          type: HookType.MERKLE_TREE,
          owner: '0x1234567890123456789012345678901234567890',
          paused: false,
        },
      },
      {
        name: 'non-boolean paused',
        input: {
          type: HookType.PAUSABLE,
          owner: '0x1234567890123456789012345678901234567890',
          paused: 'true',
        },
      },
      {
        name: 'empty owner',
        input: {
          type: HookType.PAUSABLE,
          owner: '',
          paused: false,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(PausableHookSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('OpStackHookSchema', () => {
    const validTestCases: TestCase<OpStackHookConfig>[] = [
      {
        name: 'OP Stack hook',
        input: {
          type: HookType.OP_STACK,
          owner: '0x1234567890123456789012345678901234567890',
          nativeBridge: '0x1234567890123456789012345678901234567890',
          destinationChain: 'optimism',
        },
      },
      {
        name: 'OP Stack hook with different destination',
        input: {
          type: HookType.OP_STACK,
          owner: '0x1234567890123456789012345678901234567890',
          nativeBridge: '0x2345678901234567890123456789012345678901',
          destinationChain: 'base',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(OpStackHookSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'missing owner',
        input: {
          type: HookType.OP_STACK,
          nativeBridge: '0x1234567890123456789012345678901234567890',
          destinationChain: 'optimism',
        },
      },
      {
        name: 'missing nativeBridge',
        input: {
          type: HookType.OP_STACK,
          owner: '0x1234567890123456789012345678901234567890',
          destinationChain: 'optimism',
        },
      },
      {
        name: 'missing destinationChain',
        input: {
          type: HookType.OP_STACK,
          owner: '0x1234567890123456789012345678901234567890',
          nativeBridge: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'wrong type',
        input: {
          type: HookType.MERKLE_TREE,
          owner: '0x1234567890123456789012345678901234567890',
          nativeBridge: '0x1234567890123456789012345678901234567890',
          destinationChain: 'optimism',
        },
      },
      {
        name: 'empty owner',
        input: {
          type: HookType.OP_STACK,
          owner: '',
          nativeBridge: '0x1234567890123456789012345678901234567890',
          destinationChain: 'optimism',
        },
      },
      {
        name: 'empty nativeBridge',
        input: {
          type: HookType.OP_STACK,
          owner: '0x1234567890123456789012345678901234567890',
          nativeBridge: '',
          destinationChain: 'optimism',
        },
      },
      {
        name: 'empty destinationChain',
        input: {
          type: HookType.OP_STACK,
          owner: '0x1234567890123456789012345678901234567890',
          nativeBridge: '0x1234567890123456789012345678901234567890',
          destinationChain: '',
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(OpStackHookSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('ArbL2ToL1HookSchema', () => {
    const validTestCases: TestCase<ArbL2ToL1HookConfig>[] = [
      {
        name: 'Arbitrum L2 to L1 hook',
        input: {
          type: HookType.ARB_L2_TO_L1,
          arbSys: '0x0000000000000000000000000000000000000064',
          destinationChain: 'ethereum',
          childHook: {
            type: HookType.MERKLE_TREE,
          },
        },
      },
      {
        name: 'Arbitrum L2 to L1 hook with bridge',
        input: {
          type: HookType.ARB_L2_TO_L1,
          arbSys: '0x0000000000000000000000000000000000000064',
          bridge: '0x1234567890123456789012345678901234567890',
          destinationChain: 'ethereum',
          childHook: {
            type: HookType.PROTOCOL_FEE,
            owner: '0x1234567890123456789012345678901234567890',
            beneficiary: '0x1234567890123456789012345678901234567890',
            maxProtocolFee: '1000000000000000000',
            protocolFee: '100000000000000000',
          },
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(ArbL2ToL1HookSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<ArbL2ToL1HookConfig>>[] = [
      {
        name: 'missing arbSys',
        input: {
          type: HookType.ARB_L2_TO_L1,
          destinationChain: 'ethereum',
          childHook: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'missing destinationChain',
        input: {
          type: HookType.ARB_L2_TO_L1,
          arbSys: '0x0000000000000000000000000000000000000064',
          childHook: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'missing childHook',
        input: {
          type: HookType.ARB_L2_TO_L1,
          arbSys: '0x0000000000000000000000000000000000000064',
          destinationChain: 'ethereum',
        },
      },
      {
        name: 'wrong type',
        input: {
          type: HookType.MERKLE_TREE as HookType.ARB_L2_TO_L1,
          arbSys: '0x0000000000000000000000000000000000000064',
          destinationChain: 'ethereum',
          childHook: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'empty arbSys',
        input: {
          type: HookType.ARB_L2_TO_L1,
          arbSys: '',
          destinationChain: 'ethereum',
          childHook: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'empty destinationChain',
        input: {
          type: HookType.ARB_L2_TO_L1,
          arbSys: '0x0000000000000000000000000000000000000064',
          destinationChain: '',
          childHook: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'invalid childHook',
        input: {
          type: HookType.ARB_L2_TO_L1,
          arbSys: '0x0000000000000000000000000000000000000064',
          destinationChain: 'ethereum',
          childHook: { type: 'invalidType' },
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(ArbL2ToL1HookSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('MailboxDefaultHookSchema', () => {
    const validTestCases: TestCase<MailboxDefaultHookConfig>[] = [
      {
        name: 'mailbox default hook',
        input: {
          type: HookType.MAILBOX_DEFAULT,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(MailboxDefaultHookSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'missing type',
        input: {},
      },
      {
        name: 'wrong type',
        input: {
          type: HookType.MERKLE_TREE,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(MailboxDefaultHookSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('CCIPHookSchema', () => {
    const validTestCases: TestCase<CCIPHookConfig>[] = [
      {
        name: 'CCIP hook',
        input: {
          type: HookType.CCIP,
          destinationChain: 'arbitrum',
        },
      },
      {
        name: 'CCIP hook with different destination',
        input: {
          type: HookType.CCIP,
          destinationChain: 'ethereum',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(CCIPHookSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'missing destinationChain',
        input: {
          type: HookType.CCIP,
        },
      },
      {
        name: 'wrong type',
        input: {
          type: HookType.MERKLE_TREE,
          destinationChain: 'arbitrum',
        },
      },
      {
        name: 'empty destinationChain',
        input: {
          type: HookType.CCIP,
          destinationChain: '',
        },
      },
      {
        name: 'non-string destinationChain',
        input: {
          type: HookType.CCIP,
          destinationChain: 123,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(CCIPHookSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('AggregationHookConfigSchema', () => {
    const validTestCases: TestCase<AggregationHookConfig>[] = [
      {
        name: 'aggregation hook with single hook',
        input: {
          type: HookType.AGGREGATION,
          hooks: [
            {
              type: HookType.MERKLE_TREE,
            },
          ],
        },
      },
      {
        name: 'aggregation hook with multiple hooks',
        input: {
          type: HookType.AGGREGATION,
          hooks: [
            {
              type: HookType.MERKLE_TREE,
            },
            {
              type: HookType.PROTOCOL_FEE,
              owner: '0x1234567890123456789012345678901234567890',
              beneficiary: '0x1234567890123456789012345678901234567890',
              maxProtocolFee: '1000000000000000000',
              protocolFee: '100000000000000000',
            },
          ],
        },
      },
      {
        name: 'aggregation hook with address',
        input: {
          type: HookType.AGGREGATION,
          hooks: [
            '0x1234567890123456789012345678901234567890',
            {
              type: HookType.MERKLE_TREE,
            },
          ],
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(AggregationHookConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'missing hooks',
        input: {
          type: HookType.AGGREGATION,
        },
      },
      {
        name: 'empty hooks array',
        input: {
          type: HookType.AGGREGATION,
          hooks: [],
        },
      },
      {
        name: 'wrong type',
        input: {
          type: HookType.MERKLE_TREE,
          hooks: [{ type: HookType.MERKLE_TREE }],
        },
      },
      {
        name: 'invalid hook in array',
        input: {
          type: HookType.AGGREGATION,
          hooks: [
            {
              type: 'invalidType',
            },
          ],
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(AggregationHookConfigSchema.safeParse(input).success).to.be
          .false;
      });
    });
  });

  describe('AmountRoutingHookConfigSchema', () => {
    const validTestCases: TestCase<AmountRoutingHookConfig>[] = [
      {
        name: 'amount routing hook',
        input: {
          type: HookType.AMOUNT_ROUTING,
          threshold: 1000000,
          lowerHook: {
            type: HookType.MERKLE_TREE,
          },
          upperHook: {
            type: HookType.PROTOCOL_FEE,
            owner: '0x1234567890123456789012345678901234567890',
            beneficiary: '0x1234567890123456789012345678901234567890',
            maxProtocolFee: '1000000000000000000',
            protocolFee: '100000000000000000',
          },
        },
      },
      {
        name: 'amount routing hook with address hooks',
        input: {
          type: HookType.AMOUNT_ROUTING,
          threshold: 500000,
          lowerHook: '0x1234567890123456789012345678901234567890',
          upperHook: '0x2345678901234567890123456789012345678901',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(AmountRoutingHookConfigSchema.safeParse(input).success).to.be
          .true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'missing threshold',
        input: {
          type: HookType.AMOUNT_ROUTING,
          lowerHook: { type: HookType.MERKLE_TREE },
          upperHook: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'missing lowerHook',
        input: {
          type: HookType.AMOUNT_ROUTING,
          threshold: 1000000,
          upperHook: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'missing upperHook',
        input: {
          type: HookType.AMOUNT_ROUTING,
          threshold: 1000000,
          lowerHook: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'wrong type',
        input: {
          type: HookType.MERKLE_TREE,
          threshold: 1000000,
          lowerHook: { type: HookType.MERKLE_TREE },
          upperHook: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'non-number threshold',
        input: {
          type: HookType.AMOUNT_ROUTING,
          threshold: '1000000',
          lowerHook: { type: HookType.MERKLE_TREE },
          upperHook: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'invalid lowerHook',
        input: {
          type: HookType.AMOUNT_ROUTING,
          threshold: 1000000,
          lowerHook: { type: 'invalidType' },
          upperHook: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'invalid upperHook',
        input: {
          type: HookType.AMOUNT_ROUTING,
          threshold: 1000000,
          lowerHook: { type: HookType.MERKLE_TREE },
          upperHook: { type: 'invalidType' },
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(AmountRoutingHookConfigSchema.safeParse(input).success).to.be
          .false;
      });
    });
  });

  describe('DomainRoutingHookConfigSchema', () => {
    const validTestCases: TestCase<DomainRoutingHookConfig>[] = [
      {
        name: 'domain routing hook',
        input: {
          type: HookType.ROUTING,
          owner: '0x1234567890123456789012345678901234567890',
          domains: {
            ethereum: {
              type: HookType.MERKLE_TREE,
            },
            arbitrum: '0x1234567890123456789012345678901234567890',
          },
        },
      },
      {
        name: 'domain routing hook with multiple domains',
        input: {
          type: HookType.ROUTING,
          owner: '0x1234567890123456789012345678901234567890',
          domains: {
            ethereum: {
              type: HookType.MERKLE_TREE,
            },
            arbitrum: {
              type: HookType.PROTOCOL_FEE,
              owner: '0x1234567890123456789012345678901234567890',
              beneficiary: '0x1234567890123456789012345678901234567890',
              maxProtocolFee: '1000000000000000000',
              protocolFee: '100000000000000000',
            },
            optimism: '0x1234567890123456789012345678901234567890',
          },
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(DomainRoutingHookConfigSchema.safeParse(input).success).to.be
          .true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'missing owner',
        input: {
          type: HookType.ROUTING,
          domains: {
            ethereum: { type: HookType.MERKLE_TREE },
          },
        },
      },
      {
        name: 'missing domains',
        input: {
          type: HookType.ROUTING,
          owner: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'wrong type',
        input: {
          type: HookType.MERKLE_TREE,
          owner: '0x1234567890123456789012345678901234567890',
          domains: {
            ethereum: { type: HookType.MERKLE_TREE },
          },
        },
      },
      {
        name: 'empty owner',
        input: {
          type: HookType.ROUTING,
          owner: '',
          domains: {
            ethereum: { type: HookType.MERKLE_TREE },
          },
        },
      },
      {
        name: 'invalid hook in domains',
        input: {
          type: HookType.ROUTING,
          owner: '0x1234567890123456789012345678901234567890',
          domains: {
            ethereum: { type: 'invalidType' },
          },
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(DomainRoutingHookConfigSchema.safeParse(input).success).to.be
          .false;
      });
    });
  });

  describe('FallbackRoutingHookConfigSchema', () => {
    const validTestCases: TestCase<FallbackRoutingHookConfig>[] = [
      {
        name: 'fallback routing hook',
        input: {
          type: HookType.FALLBACK_ROUTING,
          owner: '0x1234567890123456789012345678901234567890',
          domains: {
            ethereum: {
              type: HookType.MERKLE_TREE,
            },
          },
          fallback: {
            type: HookType.PROTOCOL_FEE,
            owner: '0x1234567890123456789012345678901234567890',
            beneficiary: '0x1234567890123456789012345678901234567890',
            maxProtocolFee: '1000000000000000000',
            protocolFee: '100000000000000000',
          },
        },
      },
      {
        name: 'fallback routing hook with address fallback',
        input: {
          type: HookType.FALLBACK_ROUTING,
          owner: '0x1234567890123456789012345678901234567890',
          domains: {
            ethereum: {
              type: HookType.MERKLE_TREE,
            },
            arbitrum: '0x1234567890123456789012345678901234567890',
          },
          fallback: '0x1234567890123456789012345678901234567890',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(FallbackRoutingHookConfigSchema.safeParse(input).success).to.be
          .true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'missing owner',
        input: {
          type: HookType.FALLBACK_ROUTING,
          domains: {
            ethereum: { type: HookType.MERKLE_TREE },
          },
          fallback: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'missing domains',
        input: {
          type: HookType.FALLBACK_ROUTING,
          owner: '0x1234567890123456789012345678901234567890',
          fallback: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'missing fallback',
        input: {
          type: HookType.FALLBACK_ROUTING,
          owner: '0x1234567890123456789012345678901234567890',
          domains: {
            ethereum: { type: HookType.MERKLE_TREE },
          },
        },
      },
      {
        name: 'wrong type',
        input: {
          type: HookType.ROUTING,
          owner: '0x1234567890123456789012345678901234567890',
          domains: {
            ethereum: { type: HookType.MERKLE_TREE },
          },
          fallback: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'empty owner',
        input: {
          type: HookType.FALLBACK_ROUTING,
          owner: '',
          domains: {
            ethereum: { type: HookType.MERKLE_TREE },
          },
          fallback: { type: HookType.MERKLE_TREE },
        },
      },
      {
        name: 'invalid fallback hook',
        input: {
          type: HookType.FALLBACK_ROUTING,
          owner: '0x1234567890123456789012345678901234567890',
          domains: {
            ethereum: { type: HookType.MERKLE_TREE },
          },
          fallback: { type: 'invalidType' },
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(FallbackRoutingHookConfigSchema.safeParse(input).success).to.be
          .false;
      });
    });
  });

  describe('HookConfigSchema', () => {
    const validTestCases: TestCase<unknown>[] = [
      {
        name: 'address string',
        input: '0x1234567890123456789012345678901234567890',
      },
      {
        name: 'merkle tree hook',
        input: {
          type: HookType.MERKLE_TREE,
        },
      },
      {
        name: 'protocol fee hook',
        input: {
          type: HookType.PROTOCOL_FEE,
          owner: '0x1234567890123456789012345678901234567890',
          beneficiary: '0x1234567890123456789012345678901234567890',
          maxProtocolFee: '1000000000000000000',
          protocolFee: '100000000000000000',
        },
      },
      {
        name: 'aggregation hook',
        input: {
          type: HookType.AGGREGATION,
          hooks: [
            {
              type: HookType.MERKLE_TREE,
            },
          ],
        },
      },
      {
        name: 'pausable hook',
        input: {
          type: HookType.PAUSABLE,
          owner: '0x1234567890123456789012345678901234567890',
          paused: false,
        },
      },
      {
        name: 'CCIP hook',
        input: {
          type: HookType.CCIP,
          destinationChain: 'arbitrum',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(HookConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'invalid address',
        input: 'not-an-address',
      },
      {
        name: 'invalid type',
        input: {
          type: 'invalidType',
        },
      },
      {
        name: 'incomplete protocol fee',
        input: {
          type: HookType.PROTOCOL_FEE,
          owner: '0x1234567890123456789012345678901234567890',
          // missing beneficiary, maxProtocolFee, protocolFee
        },
      },
      {
        name: 'number instead of config',
        input: 123,
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
        expect(HookConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('Edge cases and schema composition', () => {
    it('should handle complex nested hook configurations', () => {
      const complexHook = {
        type: HookType.AGGREGATION,
        hooks: [
          {
            type: HookType.ROUTING,
            owner: '0x1234567890123456789012345678901234567890',
            domains: {
              ethereum: {
                type: HookType.MERKLE_TREE,
              },
              arbitrum: {
                type: HookType.PROTOCOL_FEE,
                owner: '0x1234567890123456789012345678901234567890',
                beneficiary: '0x1234567890123456789012345678901234567890',
                maxProtocolFee: '1000000000000000000',
                protocolFee: '100000000000000000',
              },
            },
          },
          {
            type: HookType.PAUSABLE,
            owner: '0x1234567890123456789012345678901234567890',
            paused: false,
          },
        ],
      };

      expect(HookConfigSchema.safeParse(complexHook).success).to.be.true;
    });

    it('should handle circular references in ArbL2ToL1Hook', () => {
      const arbHook = {
        type: HookType.ARB_L2_TO_L1,
        arbSys: '0x0000000000000000000000000000000000000064',
        destinationChain: 'ethereum',
        childHook: {
          type: HookType.AGGREGATION,
          hooks: [
            {
              type: HookType.MERKLE_TREE,
            },
          ],
        },
      };

      expect(HookConfigSchema.safeParse(arbHook).success).to.be.true;
    });

    it('should handle all hook types in union', () => {
      const hookTypeTestCases: TestCase<unknown>[] = [
        {
          name: 'merkle tree hook',
          input: { type: HookType.MERKLE_TREE },
        },
        {
          name: 'IGP hook',
          input: {
            type: HookType.INTERCHAIN_GAS_PAYMASTER,
            owner: '0x1234567890123456789012345678901234567890',
            beneficiary: '0x1234567890123456789012345678901234567890',
            oracleKey: '0x1234567890123456789012345678901234567890',
            overhead: { ethereum: 50000 },
            oracleConfig: { ethereum: {} },
          },
        },
        {
          name: 'protocol fee hook',
          input: {
            type: HookType.PROTOCOL_FEE,
            owner: '0x1234567890123456789012345678901234567890',
            beneficiary: '0x1234567890123456789012345678901234567890',
            maxProtocolFee: '1000000000000000000',
            protocolFee: '100000000000000000',
          },
        },
        {
          name: 'pausable hook',
          input: {
            type: HookType.PAUSABLE,
            owner: '0x1234567890123456789012345678901234567890',
            paused: false,
          },
        },
        {
          name: 'OP Stack hook',
          input: {
            type: HookType.OP_STACK,
            owner: '0x1234567890123456789012345678901234567890',
            nativeBridge: '0x1234567890123456789012345678901234567890',
            destinationChain: 'optimism',
          },
        },
        {
          name: 'domain routing hook',
          input: {
            type: HookType.ROUTING,
            owner: '0x1234567890123456789012345678901234567890',
            domains: {
              ethereum: { type: HookType.MERKLE_TREE },
            },
          },
        },
        {
          name: 'fallback routing hook',
          input: {
            type: HookType.FALLBACK_ROUTING,
            owner: '0x1234567890123456789012345678901234567890',
            domains: {
              ethereum: { type: HookType.MERKLE_TREE },
            },
            fallback: { type: HookType.MERKLE_TREE },
          },
        },
        {
          name: 'amount routing hook',
          input: {
            type: HookType.AMOUNT_ROUTING,
            threshold: 1000000,
            lowerHook: { type: HookType.MERKLE_TREE },
            upperHook: { type: HookType.MERKLE_TREE },
          },
        },
        {
          name: 'aggregation hook',
          input: {
            type: HookType.AGGREGATION,
            hooks: [{ type: HookType.MERKLE_TREE }],
          },
        },
        {
          name: 'Arbitrum L2 to L1 hook',
          input: {
            type: HookType.ARB_L2_TO_L1,
            arbSys: '0x0000000000000000000000000000000000000064',
            destinationChain: 'ethereum',
            childHook: { type: HookType.MERKLE_TREE },
          },
        },
        {
          name: 'mailbox default hook',
          input: { type: HookType.MAILBOX_DEFAULT },
        },
        {
          name: 'CCIP hook',
          input: {
            type: HookType.CCIP,
            destinationChain: 'arbitrum',
          },
        },
      ];

      hookTypeTestCases.forEach(({ name, input }) => {
        it(`should accept ${name}`, () => {
          expect(HookConfigSchema.safeParse(input).success).to.be.true;
        });
      });
    });
  });
});
