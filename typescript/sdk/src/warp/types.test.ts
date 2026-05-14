import { expect } from 'chai';

import { TokenStandard } from '../token/TokenStandard.js';

import { WarpCoreConfigSchema } from './types.js';

const SOME_TOKEN = {
  chainName: 'ethereum',
  standard: TokenStandard.EvmHypNative,
  decimals: 18,
  symbol: 'TST',
  name: 'Test',
  addressOrDenom: '0x0000000000000000000000000000000000000001',
};

describe('WarpCoreConfigSchema.options.svmAltAddresses', () => {
  it('accepts a config without the field', () => {
    const result = WarpCoreConfigSchema.safeParse({ tokens: [SOME_TOKEN] });
    expect(result.success, JSON.stringify(result, null, 2)).to.equal(true);
  });

  it('accepts per-chain { core, warpSpecific } entries', () => {
    const result = WarpCoreConfigSchema.safeParse({
      tokens: [SOME_TOKEN],
      options: {
        svmAltAddresses: {
          solana: {
            core: 'CoreA1t111111111111111111111111111111111111',
            warpSpecific: ['WarpA1t111111111111111111111111111111111111'],
          },
        },
      },
    });
    expect(result.success, JSON.stringify(result, null, 2)).to.equal(true);
  });

  it('rejects an empty warpSpecific array', () => {
    const result = WarpCoreConfigSchema.safeParse({
      tokens: [SOME_TOKEN],
      options: {
        svmAltAddresses: {
          solana: {
            core: 'CoreA1t111111111111111111111111111111111111',
            warpSpecific: [],
          },
        },
      },
    });
    expect(result.success).to.equal(false);
  });

  it('rejects a missing core', () => {
    const result = WarpCoreConfigSchema.safeParse({
      tokens: [SOME_TOKEN],
      options: {
        svmAltAddresses: {
          solana: {
            warpSpecific: ['WarpA1t111111111111111111111111111111111111'],
          },
        },
      },
    });
    expect(result.success).to.equal(false);
  });
});
