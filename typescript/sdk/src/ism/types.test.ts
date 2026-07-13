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
    owner: SOME_ADDRESS,
    root: {
      type: 'aggregation',
      threshold: 2,
      subIsms: [
        { type: 'trustedRelayer', relayer: SOME_ADDRESS },
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
            mailbox: SOME_ADDRESS,
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
        subIsms: [{ type: 'trustedRelayer', relayer: SOME_ADDRESS }],
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(tooHigh).success).to.be.false;

    const tooLow = {
      ...sample,
      root: {
        type: 'aggregation',
        threshold: 0,
        subIsms: [{ type: 'trustedRelayer', relayer: SOME_ADDRESS }],
      },
    };
    expect(CompositeIsmConfigSchema.safeParse(tooLow).success).to.be.false;
  });
});
