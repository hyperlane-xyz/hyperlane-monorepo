import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  AggregationIsmConfigSchema,
  CompositeIsmConfigSchema,
  IsmConfigSchema,
  IsmType,
  ModuleType,
  ismTypeToModuleType,
} from './types.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;
const OTHER_ADDRESS = ethers.Wallet.createRandom().address;

// Composite ISM (Sealevel-only) wire fields have distinct formats from the
// generic EVM-style addresses above: owner/relayer/mailbox/fallbackIsm are
// base58 Sealevel pubkeys, and recipient is a 32-byte (64 hex char) H256.
const SEALEVEL_ADDRESS = '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf';
const OTHER_SEALEVEL_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SEALEVEL_ZERO_ADDRESS = '1'.repeat(32);
const H256_ADDRESS = '0x' + '5'.repeat(64);
const H256_ZERO = '0x' + '0'.repeat(64);

describe('AggregationIsmConfigSchema refine', () => {
  it('should require threshold to be below modules length', () => {
    const IsmConfig = {
      type: IsmType.AGGREGATION,
      modules: [SOME_ADDRESS],
      threshold: 100,
    };
    expect(AggregationIsmConfigSchema.safeParse(IsmConfig).success).to.be.false;

    IsmConfig.threshold = 0;
    expect(AggregationIsmConfigSchema.safeParse(IsmConfig).success).to.be.true;
  });
});

describe('ModuleType', () => {
  // Must match solidity/contracts/interfaces/IInterchainSecurityModule.sol's
  // Types enum exactly (COMPOSITE is Sealevel-only, no Solidity counterpart —
  // matches rust/main/hyperlane-core's ModuleType instead).
  it('has explicit values matching IInterchainSecurityModule.sol', () => {
    expect(ModuleType.UNUSED).to.equal(0);
    expect(ModuleType.ROUTING).to.equal(1);
    expect(ModuleType.AGGREGATION).to.equal(2);
    expect(ModuleType.LEGACY_MULTISIG).to.equal(3);
    expect(ModuleType.MERKLE_ROOT_MULTISIG).to.equal(4);
    expect(ModuleType.MESSAGE_ID_MULTISIG).to.equal(5);
    expect(ModuleType.NULL).to.equal(6);
    expect(ModuleType.CCIP_READ).to.equal(7);
    expect(ModuleType.ARB_L2_TO_L1).to.equal(8);
    expect(ModuleType.WEIGHTED_MERKLE_ROOT_MULTISIG).to.equal(9);
    expect(ModuleType.WEIGHTED_MESSAGE_ID_MULTISIG).to.equal(10);
    expect(ModuleType.OP_L2_TO_L1).to.equal(11);
    expect(ModuleType.POLYMER).to.equal(12);
    expect(ModuleType.COMPOSITE).to.equal(13);
  });

  it('maps IsmType.COMPOSITE to ModuleType.COMPOSITE', () => {
    expect(ismTypeToModuleType(IsmType.COMPOSITE)).to.equal(
      ModuleType.COMPOSITE,
    );
  });
});

describe('CompositeIsmConfigSchema', () => {
  const sample = {
    type: IsmType.COMPOSITE,
    owner: SEALEVEL_ADDRESS,
    root: {
      type: 'aggregation',
      threshold: 2,
      subIsms: [
        { type: 'trustedRelayer', relayer: SEALEVEL_ADDRESS },
        {
          type: 'routing',
          domains: {
            solanamainnet: { type: 'test', accept: true },
          },
        },
        {
          type: 'amountRouting',
          threshold: '1000000',
          lower: { type: 'pausable', paused: false },
          upper: {
            type: 'rateLimited',
            maxCapacity: '86400',
            mailbox: SEALEVEL_ADDRESS,
            recipient: H256_ADDRESS,
          },
        },
      ],
    },
  };

  it('parses a nested composite ISM tree', () => {
    const result = CompositeIsmConfigSchema.safeParse(sample);
    expect(result.success).to.be.true;
  });

  it('parses via the top-level IsmConfigSchema union', () => {
    const result = IsmConfigSchema.safeParse(sample);
    expect(result.success).to.be.true;
    if (
      result.success &&
      typeof result.data === 'object' &&
      result.data !== null &&
      'type' in result.data
    ) {
      expect(result.data.type).to.equal('compositeIsm');
    }
  });

  it('rejects an unknown node type', () => {
    const invalid = {
      ...sample,
      root: { type: 'notARealNodeType', foo: 'bar' },
    };
    expect(CompositeIsmConfigSchema.safeParse(invalid).success).to.be.false;
  });

  it('rejects an aggregation node with an out-of-range threshold', () => {
    const tooHigh = {
      ...sample,
      root: {
        type: 'aggregation',
        threshold: 5,
        subIsms: [{ type: 'trustedRelayer', relayer: SEALEVEL_ADDRESS }],
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(tooHigh).success).to.be.false;

    const tooLow = {
      ...sample,
      root: {
        type: 'aggregation',
        threshold: 0,
        subIsms: [{ type: 'trustedRelayer', relayer: SEALEVEL_ADDRESS }],
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(tooLow).success).to.be.false;
  });

  it('rejects a multisigMessageId node with duplicate validators', () => {
    const invalid = {
      ...sample,
      root: {
        type: 'multisigMessageId',
        threshold: 1,
        validators: [SOME_ADDRESS, '0x' + SOME_ADDRESS.slice(2).toUpperCase()],
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(invalid).success).to.be.false;
  });

  it('rejects a multisigMessageId node with an out-of-range threshold', () => {
    const invalid = {
      ...sample,
      root: {
        type: 'multisigMessageId',
        threshold: 3,
        validators: [SOME_ADDRESS, OTHER_ADDRESS],
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(invalid).success).to.be.false;
  });

  it('rejects a multisigMessageId node with a non-integer threshold', () => {
    const invalid = {
      ...sample,
      root: {
        type: 'multisigMessageId',
        threshold: 1.5,
        validators: [SOME_ADDRESS, OTHER_ADDRESS],
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(invalid).success).to.be.false;
  });

  it('rejects a multisigMessageId node with a base58 pubkey as a validator', () => {
    const invalid = {
      ...sample,
      root: {
        type: 'multisigMessageId',
        threshold: 1,
        validators: [SEALEVEL_ADDRESS],
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(invalid).success).to.be.false;
  });

  it('rejects a rateLimited node with a zero mailbox or missing/zero recipient', () => {
    const zeroMailbox = {
      ...sample,
      root: {
        type: 'rateLimited',
        maxCapacity: '86400',
        mailbox: SEALEVEL_ZERO_ADDRESS,
        recipient: H256_ADDRESS,
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(zeroMailbox).success).to.be.false;

    const missingRecipient = {
      ...sample,
      root: {
        type: 'rateLimited',
        maxCapacity: '86400',
        mailbox: SEALEVEL_ADDRESS,
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(missingRecipient).success).to.be
      .false;

    const zeroRecipient = {
      ...sample,
      root: {
        type: 'rateLimited',
        maxCapacity: '86400',
        mailbox: SEALEVEL_ADDRESS,
        recipient: H256_ZERO,
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(zeroRecipient).success).to.be
      .false;
  });

  it('rejects a rateLimited node with maxCapacity above u64::MAX', () => {
    const invalid = {
      ...sample,
      root: {
        type: 'rateLimited',
        maxCapacity: (2n ** 64n).toString(),
        mailbox: SEALEVEL_ADDRESS,
        recipient: H256_ADDRESS,
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(invalid).success).to.be.false;
  });

  it('rejects an amountRouting node with threshold above u256::MAX', () => {
    const invalid = {
      ...sample,
      root: {
        type: 'amountRouting',
        threshold: (2n ** 256n).toString(),
        lower: { type: 'test', accept: true },
        upper: { type: 'test', accept: false },
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(invalid).success).to.be.false;
  });

  it('rejects a trustedRelayer node with a zero relayer', () => {
    const invalid = {
      ...sample,
      root: { type: 'trustedRelayer', relayer: SEALEVEL_ZERO_ADDRESS },
    };
    expect(CompositeIsmConfigSchema.safeParse(invalid).success).to.be.false;
  });

  it('rejects a trustedRelayer node with an EVM-style hex relayer', () => {
    const invalid = {
      ...sample,
      root: { type: 'trustedRelayer', relayer: SOME_ADDRESS },
    };
    expect(CompositeIsmConfigSchema.safeParse(invalid).success).to.be.false;
  });

  it('rejects more than one routing/fallbackRouting node in the tree', () => {
    const invalid = {
      ...sample,
      root: {
        type: 'aggregation',
        threshold: 1,
        subIsms: [
          { type: 'routing', domains: {} },
          {
            type: 'fallbackRouting',
            fallbackIsm: SEALEVEL_ADDRESS,
            domains: {},
          },
        ],
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(invalid).success).to.be.false;
  });

  it('rejects a fallbackRouting node with a zero fallbackIsm', () => {
    const invalid = {
      ...sample,
      root: {
        type: 'fallbackRouting',
        fallbackIsm: SEALEVEL_ZERO_ADDRESS,
        domains: {},
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(invalid).success).to.be.false;
  });

  it('rejects fallbackRouting nested anywhere but last in an aggregation', () => {
    const invalid = {
      ...sample,
      root: {
        type: 'aggregation',
        threshold: 2,
        subIsms: [
          {
            type: 'fallbackRouting',
            fallbackIsm: SEALEVEL_ADDRESS,
            domains: {},
          },
          { type: 'trustedRelayer', relayer: SEALEVEL_ADDRESS },
        ],
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(invalid).success).to.be.false;
  });

  it('rejects routing, fallbackRouting, or pausable nested inside a domain override', () => {
    const nestedRouting = {
      ...sample,
      root: {
        type: 'routing',
        domains: { ethereum: { type: 'routing', domains: {} } },
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(nestedRouting).success).to.be
      .false;

    const nestedFallbackRouting = {
      ...sample,
      root: {
        type: 'routing',
        domains: {
          ethereum: {
            type: 'fallbackRouting',
            fallbackIsm: SEALEVEL_ADDRESS,
            domains: {},
          },
        },
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(nestedFallbackRouting).success).to
      .be.false;

    const nestedPausable = {
      ...sample,
      root: {
        type: 'routing',
        domains: { ethereum: { type: 'pausable', paused: false } },
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(nestedPausable).success).to.be
      .false;
  });

  it('accepts a domain override with an allowed nested type', () => {
    const valid = {
      ...sample,
      root: {
        type: 'routing',
        domains: {
          ethereum: {
            type: 'multisigMessageId',
            validators: [SOME_ADDRESS, OTHER_ADDRESS],
            threshold: 1,
          },
        },
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(valid).success).to.be.true;
  });

  it('accepts a second, distinct base58 pubkey for trustedRelayer', () => {
    const valid = {
      ...sample,
      root: { type: 'trustedRelayer', relayer: OTHER_SEALEVEL_ADDRESS },
    };
    expect(CompositeIsmConfigSchema.safeParse(valid).success).to.be.true;
  });
});
