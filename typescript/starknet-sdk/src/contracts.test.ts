import { expect } from 'chai';

import { ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';

import {
  extractEnumVariant,
  getFeeTokenAddress,
  normalizeStarknetAddressSafe,
} from './contracts.js';

describe('starknet-sdk contracts helpers', () => {
  it('normalizes zeroish addresses to 32-byte zero address', () => {
    expect(normalizeStarknetAddressSafe('0x0')).to.equal(ZERO_ADDRESS_HEX_32);
  });

  it('uses native denom as fee token when provided', () => {
    const nativeDenom = '0x1234';
    expect(
      getFeeTokenAddress({ chainName: 'starknetsepolia', nativeDenom }),
    ).to.equal(
      '0x0000000000000000000000000000000000000000000000000000000000001234',
    );
  });

  it('falls back to known fee token by chain name', () => {
    expect(
      getFeeTokenAddress({ chainName: 'starknetsepolia' }),
    ).to.equal(
      '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    );
  });

  it('extracts enum variant key from starknet-like object', () => {
    expect(extractEnumVariant({ MERKLE_TREE: {} })).to.equal('MERKLE_TREE');
  });
});
