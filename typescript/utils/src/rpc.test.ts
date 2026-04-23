import { expect } from 'vitest';

import { applyRpcUrlOverridesFromEnv } from './rpc.js';

describe('applyRpcUrlOverridesFromEnv', () => {
  it('applies overrides for all chains by default', () => {
    const metadata = {
      ethereum: { rpcUrls: [{ http: 'https://registry-ethereum.example' }] },
      arbitrum: { rpcUrls: [{ http: 'https://registry-arbitrum.example' }] },
    };

    const overriddenChains = applyRpcUrlOverridesFromEnv(metadata, {
      env: {
        RPC_URL_ETHEREUM: 'https://private-ethereum.example',
      },
    });

    expect(overriddenChains).toEqual(['ethereum']);
    expect(metadata.ethereum.rpcUrls?.[0].http).toBe(
      'https://private-ethereum.example',
    );
    expect(metadata.arbitrum.rpcUrls?.[0].http).toBe(
      'https://registry-arbitrum.example',
    );
  });

  it('supports hyphenated chain names', () => {
    const metadata = {
      'arbitrum-sepolia': {
        rpcUrls: [{ http: 'https://registry-arbitrum-sepolia.example' }],
      },
    };

    const overriddenChains = applyRpcUrlOverridesFromEnv(metadata, {
      env: {
        RPC_URL_ARBITRUM_SEPOLIA: 'https://private-arbitrum-sepolia.example',
      },
    });

    expect(overriddenChains).toEqual(['arbitrum-sepolia']);
    expect(metadata['arbitrum-sepolia'].rpcUrls?.[0].http).toBe(
      'https://private-arbitrum-sepolia.example',
    );
  });

  it('can scope overrides to specific chains', () => {
    const metadata = {
      ethereum: { rpcUrls: [{ http: 'https://registry-ethereum.example' }] },
      arbitrum: { rpcUrls: [{ http: 'https://registry-arbitrum.example' }] },
    };

    const overriddenChains = applyRpcUrlOverridesFromEnv(metadata, {
      chainNames: ['arbitrum'],
      env: {
        RPC_URL_ETHEREUM: 'https://private-ethereum.example',
        RPC_URL_ARBITRUM: 'https://private-arbitrum.example',
      },
    });

    expect(overriddenChains).toEqual(['arbitrum']);
    expect(metadata.ethereum.rpcUrls?.[0].http).toBe(
      'https://registry-ethereum.example',
    );
    expect(metadata.arbitrum.rpcUrls?.[0].http).toBe(
      'https://private-arbitrum.example',
    );
  });
});
