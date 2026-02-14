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

  const invalidGetAccountInfoCases: Array<{
    title: string;
    provider: unknown;
    getAccountInfoType: string;
  }> = [
    {
      title: 'throws for malformed provider values',
      provider: {},
      getAccountInfoType: 'undefined',
    },
    {
      title: 'throws when getAccountInfo exists but is not callable',
      provider: { getAccountInfo: 'not-a-function' },
      getAccountInfoType: 'string',
    },
    {
      title: 'labels array getAccountInfo values in malformed provider errors',
      provider: { getAccountInfo: [] },
      getAccountInfoType: 'array',
    },
    {
      title: 'labels null getAccountInfo values in malformed provider errors',
      provider: { getAccountInfo: null },
      getAccountInfoType: 'null',
    },
    {
      title: 'labels boolean getAccountInfo values in malformed provider errors',
      provider: { getAccountInfo: false },
      getAccountInfoType: 'boolean',
    },
    {
      title: 'labels object getAccountInfo values in malformed provider errors',
      provider: { getAccountInfo: {} },
      getAccountInfoType: 'object',
    },
  ];

  for (const { title, provider, getAccountInfoType } of invalidGetAccountInfoCases) {
    it(title, () => {
      expectInvalidProvider(provider, getAccountInfoType, 'object');
    });
  }

  const invalidProviderContainerCases: Array<{
    title: string;
    provider: unknown;
    providerType: string;
  }> = [
    {
      title: 'throws for null malformed provider values',
      provider: null,
      providerType: 'null',
    },
    {
      title: 'throws for undefined malformed provider values',
      provider: undefined,
      providerType: 'undefined',
    },
    {
      title: 'labels array provider containers in malformed provider errors',
      provider: [],
      providerType: 'array',
    },
    {
      title: 'labels numeric provider containers in malformed provider errors',
      provider: 1,
      providerType: 'number',
    },
    {
      title: 'labels string provider containers in malformed provider errors',
      provider: 'invalid-provider',
      providerType: 'string',
    },
    {
      title: 'labels boolean provider containers in malformed provider errors',
      provider: false,
      providerType: 'boolean',
    },
    {
      title: 'labels bigint provider containers in malformed provider errors',
      provider: 1n,
      providerType: 'bigint',
    },
  ];

  for (const { title, provider, providerType } of invalidProviderContainerCases) {
    it(title, () => {
      expectInvalidProvider(provider, 'undefined', providerType);
    });
  }
});
