import { expect } from 'chai';

import {
  WormholeConsistencyLevel,
  WormholeConsistencyLevelConfigSchema,
  WormholeConsistencyType,
  WormholeVaaConsistencyLevelSchema,
  consistencyLevelConfigFromOnchain,
  consistencyLevelConfigToOnchain,
  consistencyLevelForConfig,
} from './consistency.js';

const CCL = '0x0000000000000000000000000000000000000001';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

interface OnchainConsistency {
  consistencyLevel: number;
  customConsistencyLevelContract: string;
  customBaseConsistencyLevel: number;
  additionalBlocks: number;
}

interface RoundTripCase {
  name: string;
  onchain: OnchainConsistency;
  config: unknown;
}

const roundTripCases: RoundTripCase[] = [
  {
    name: 'zero finalized',
    onchain: {
      consistencyLevel: 0,
      customConsistencyLevelContract: ZERO_ADDRESS,
      customBaseConsistencyLevel: 0,
      additionalBlocks: 0,
    },
    config: { type: 'zeroFinalized' },
  },
  {
    name: 'instant',
    onchain: {
      consistencyLevel: 200,
      customConsistencyLevelContract: ZERO_ADDRESS,
      customBaseConsistencyLevel: 0,
      additionalBlocks: 0,
    },
    config: { type: 'instant' },
  },
  {
    name: 'safe',
    onchain: {
      consistencyLevel: 201,
      customConsistencyLevelContract: ZERO_ADDRESS,
      customBaseConsistencyLevel: 0,
      additionalBlocks: 0,
    },
    config: { type: 'safe' },
  },
  {
    name: 'finalized',
    onchain: {
      consistencyLevel: 202,
      customConsistencyLevelContract: ZERO_ADDRESS,
      customBaseConsistencyLevel: 0,
      additionalBlocks: 0,
    },
    config: { type: 'finalized' },
  },
  {
    name: 'custom',
    onchain: {
      consistencyLevel: 203,
      customConsistencyLevelContract: CCL,
      customBaseConsistencyLevel: 201,
      additionalBlocks: 7,
    },
    config: {
      type: 'custom',
      address: CCL,
      baseConsistencyLevel: 'safe',
      additionalBlocks: 7,
    },
  },
];

describe('Wormhole consistency levels', () => {
  for (const c of roundTripCases) {
    it(`round-trips ${c.name} from wire to config and back`, () => {
      const { onchain } = c;
      const expected = WormholeConsistencyLevelConfigSchema.parse(c.config);

      const config = consistencyLevelConfigFromOnchain(
        onchain.consistencyLevel,
        onchain.consistencyLevel === 203
          ? {
              address: onchain.customConsistencyLevelContract,
              baseConsistencyLevel: onchain.customBaseConsistencyLevel,
              additionalBlocks: onchain.additionalBlocks,
            }
          : undefined,
      );

      expect(config).to.deep.equal(expected);
      expect(consistencyLevelConfigToOnchain(config)).to.deep.equal(onchain);
      expect(consistencyLevelForConfig(config)).to.equal(
        onchain.consistencyLevel,
      );
    });
  }

  it('rejects a custom base level of zero from contract getters', () => {
    expect(() =>
      consistencyLevelConfigFromOnchain(WormholeConsistencyLevel.Custom, {
        address: CCL,
        baseConsistencyLevel: 0,
        additionalBlocks: 1,
      }),
    ).to.throw('Unsupported standard Wormhole consistency level 0');
  });

  it('rejects a custom base level of zero finalized in config', () => {
    expect(() =>
      WormholeConsistencyLevelConfigSchema.parse({
        type: WormholeConsistencyType.Custom,
        address: CCL,
        baseConsistencyLevel: WormholeConsistencyType.ZeroFinalized,
        additionalBlocks: 1,
      }),
    ).to.throw(/baseConsistencyLevel/);
  });

  it('rejects unsupported standard consistency values', () => {
    expect(() => consistencyLevelConfigFromOnchain(15)).to.throw(
      'Unsupported standard Wormhole consistency level 15',
    );
  });
});

describe('WormholeVaaConsistencyLevelSchema', () => {
  for (const level of [0, 1, 32, 200, 201, 202, 203]) {
    it(`accepts ${level}`, () => {
      expect(WormholeVaaConsistencyLevelSchema.parse(level)).to.equal(level);
    });
  }

  it('rejects a level the contract does not accept', () => {
    expect(() => WormholeVaaConsistencyLevelSchema.parse(2)).to.throw();
  });
});
