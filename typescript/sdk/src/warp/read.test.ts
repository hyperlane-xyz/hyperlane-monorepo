import { expect } from 'vitest';

import { TokenStandard } from '../token/TokenStandard.js';

import { buildWarpRouteMaps } from './read.js';

describe(buildWarpRouteMaps.name, () => {
  it('builds route maps with lowercased route ids and wire decimals', () => {
    const result = buildWarpRouteMaps({
      'USDC/Mainnet': {
        tokens: [
          {
            chainName: 'ethereum',
            addressOrDenom: '0xA',
            decimals: 6,
            name: 'USDC',
            symbol: 'USDC',
            standard: TokenStandard.EvmHypSynthetic,
          },
          {
            chainName: 'sepolia',
            addressOrDenom: '0xB',
            decimals: 18,
            name: 'USDC',
            symbol: 'USDC',
            standard: TokenStandard.EvmHypSynthetic,
          },
        ],
      },
    });

    expect(result.warpRouteIdToAddressesMap).toEqual({
      'usdc/mainnet': [
        { chainName: 'ethereum', address: '0xA' },
        { chainName: 'sepolia', address: '0xB' },
      ],
    });
    expect(result.warpRouteChainAddressMap.ethereum['0xA']?.wireDecimals).toBe(
      18,
    );
    expect(result.warpRouteChainAddressMap.sepolia['0xB']?.wireDecimals).toBe(
      18,
    );
  });

  it('skips tokens without an address or denom', () => {
    const result = buildWarpRouteMaps({
      route: {
        tokens: [
          {
            chainName: 'ethereum',
            addressOrDenom: '',
            decimals: 18,
            name: 'ETH',
            symbol: 'ETH',
            standard: TokenStandard.EvmNative,
          },
        ],
      },
    });

    expect(result.warpRouteChainAddressMap).toEqual({});
    expect(result.warpRouteIdToAddressesMap.route).toEqual([]);
  });
});
