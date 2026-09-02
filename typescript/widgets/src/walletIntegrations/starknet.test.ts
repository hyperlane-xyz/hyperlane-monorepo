import assert from 'node:assert/strict';

import type { Chain } from '@starknet-react/chains';

import { starknetPaymasterProvider } from './starknet.js';

const chain: Chain = {
  id: 1n,
  name: 'Custom Starknet chain',
  network: 'custom',
  nativeCurrency: {
    address: '0x0',
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
  },
  rpcUrls: {
    default: { http: ['https://default.rpc.example'] },
    public: { http: ['https://public.rpc.example'] },
  },
  paymasterRpcUrls: {},
};

describe('starknetPaymasterProvider', () => {
  it('supports custom chains without paymaster metadata', () => {
    const provider = starknetPaymasterProvider(chain);

    assert.equal(provider?.nodeUrl, 'https://public.rpc.example');
  });

  it('prefers a configured AVNU paymaster endpoint', () => {
    const provider = starknetPaymasterProvider({
      ...chain,
      paymasterRpcUrls: {
        avnu: { http: ['https://paymaster.example'] },
      },
    });

    assert.equal(provider?.nodeUrl, 'https://paymaster.example');
  });
});
