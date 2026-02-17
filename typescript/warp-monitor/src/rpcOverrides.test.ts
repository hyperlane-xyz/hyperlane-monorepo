import { expect } from 'chai';

import type { ChainMetadata } from '@hyperlane-xyz/sdk';

import { applyRpcOverrides } from './rpcOverrides.js';

describe('applyRpcOverrides', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('applies RPC_URL_<CHAIN> overrides', () => {
    const chainMetadata: Record<string, Partial<ChainMetadata>> = {
      ethereum: {
        rpcUrls: [{ http: 'https://registry-ethereum.example' }],
      },
      'arbitrum-sepolia': {
        rpcUrls: [{ http: 'https://registry-arbitrum.example' }],
      },
    };

    process.env.RPC_URL_ETHEREUM = 'https://override-ethereum.example';
    process.env.RPC_URL_ARBITRUM_SEPOLIA = 'https://override-arbitrum.example';

    const overriddenChains = applyRpcOverrides(chainMetadata);

    expect(new Set(overriddenChains)).to.deep.equal(
      new Set(['ethereum', 'arbitrum-sepolia']),
    );
    expect(chainMetadata.ethereum.rpcUrls?.[0].http).to.equal(
      'https://override-ethereum.example',
    );
    expect(chainMetadata['arbitrum-sepolia'].rpcUrls?.[0].http).to.equal(
      'https://override-arbitrum.example',
    );
  });

  it('does not modify chains without overrides', () => {
    const chainMetadata: Record<string, Partial<ChainMetadata>> = {
      ethereum: {
        rpcUrls: [{ http: 'https://registry-ethereum.example' }],
      },
    };

    const overriddenChains = applyRpcOverrides(chainMetadata);

    expect(overriddenChains).to.deep.equal([]);
    expect(chainMetadata.ethereum.rpcUrls?.[0].http).to.equal(
      'https://registry-ethereum.example',
    );
  });
});
