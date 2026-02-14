import { expect } from 'chai';
import { Connection } from '@solana/web3.js';

import type { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { toSquadsProvider } from './provider.js';

type SolanaProvider = ReturnType<
  MultiProtocolProvider['getSolanaWeb3Provider']
>;

function expectInvalidProvider(
  provider: unknown,
  getAccountInfoType: string,
  providerType: string,
) {
  expect(() => toSquadsProvider(provider as SolanaProvider)).to.throw(
    `Invalid Solana provider: expected getAccountInfo function, got ${getAccountInfoType} (provider: ${providerType})`,
  );
}

describe('squads provider bridge', () => {
  it('returns the same provider for valid solana connection', () => {
    const provider = new Connection('http://localhost:8899');
    expect(toSquadsProvider(provider as SolanaProvider)).to.equal(provider);
  });

  it('accepts provider-like objects with callable getAccountInfo', () => {
    const providerLike = {
      getAccountInfo: async () => null,
    } as unknown as SolanaProvider;

    expect(toSquadsProvider(providerLike)).to.equal(providerLike);
  });

  it('accepts provider-like objects inheriting callable getAccountInfo', () => {
    const providerPrototype = {
      getAccountInfo: async () => null,
    };
    const providerLike = Object.create(providerPrototype) as SolanaProvider;

    expect(toSquadsProvider(providerLike)).to.equal(providerLike);
  });

  it('throws for malformed provider values', () => {
    expectInvalidProvider({}, 'undefined', 'object');
  });

  it('throws when getAccountInfo exists but is not callable', () => {
    expectInvalidProvider(
      { getAccountInfo: 'not-a-function' },
      'string',
      'object',
    );
  });

  it('labels array getAccountInfo values in malformed provider errors', () => {
    expectInvalidProvider({ getAccountInfo: [] }, 'array', 'object');
  });

  it('labels null getAccountInfo values in malformed provider errors', () => {
    expectInvalidProvider({ getAccountInfo: null }, 'null', 'object');
  });

  it('labels boolean getAccountInfo values in malformed provider errors', () => {
    expectInvalidProvider({ getAccountInfo: false }, 'boolean', 'object');
  });

  it('labels object getAccountInfo values in malformed provider errors', () => {
    expectInvalidProvider({ getAccountInfo: {} }, 'object', 'object');
  });

  it('throws for null malformed provider values', () => {
    expectInvalidProvider(null, 'undefined', 'null');
  });

  it('throws for undefined malformed provider values', () => {
    expectInvalidProvider(undefined, 'undefined', 'undefined');
  });

  it('labels array provider containers in malformed provider errors', () => {
    expectInvalidProvider([], 'undefined', 'array');
  });
});
