import { expect } from 'chai';

import { ProtocolType, normalizeAddress } from '@hyperlane-xyz/utils';

import {
  TokenConnectionType,
  getTokenConnectionId,
} from '../token/TokenConnection.js';
import { TokenStandard } from '../token/TokenStandard.js';

import {
  buildWarpRouteMaps,
  buildWarpRouteTokens,
  buildWarpRouteWireDecimalsMap,
} from './read.js';
import type { WarpCoreConfig } from './types.js';

describe('warp read helpers', () => {
  const config: WarpCoreConfig = {
    tokens: [
      {
        chainName: 'ethereum',
        standard: TokenStandard.EvmHypCollateral,
        decimals: 18,
        symbol: 'ETH',
        name: 'Ether',
        addressOrDenom: '0x1111111111111111111111111111111111111111',
        connections: [
          {
            type: TokenConnectionType.Hyperlane,
            token: getTokenConnectionId(
              ProtocolType.Ethereum,
              'arbitrum',
              '0x2222222222222222222222222222222222222222',
            ),
          },
        ],
      },
      {
        chainName: 'arbitrum',
        standard: TokenStandard.EvmHypSynthetic,
        decimals: 6,
        symbol: 'ETH',
        name: 'Ether',
        addressOrDenom: '0x2222222222222222222222222222222222222222',
      },
    ],
  };

  it('builds connected TokenMetadata objects from config', () => {
    const tokens = buildWarpRouteTokens(config);

    expect(tokens).to.have.length(2);
    expect(tokens[0]?.getConnections()).to.have.length(1);
    expect(tokens[0]?.getConnections()[0]?.token.chainName).to.equal(
      'arbitrum',
    );
  });

  it('builds route maps from config records', () => {
    const result = buildWarpRouteMaps({ 'ETH/ethereum-arbitrum': config });

    expect(
      result.warpRouteIdToAddressesMap['eth/ethereum-arbitrum'],
    ).to.deep.equal([
      {
        chainName: 'ethereum',
        address: '0x1111111111111111111111111111111111111111',
      },
      {
        chainName: 'arbitrum',
        address: '0x2222222222222222222222222222222222222222',
      },
    ]);
    expect(
      result.warpRouteChainAddressMap.ethereum[
        '0x1111111111111111111111111111111111111111'
      ]?.wireDecimals,
    ).to.equal(18);
  });

  it('builds wire-decimal maps from tokens', () => {
    const tokens = buildWarpRouteTokens(config);
    const result = buildWarpRouteWireDecimalsMap(tokens, {
      ethereum: {
        '0x1111111111111111111111111111111111111111': 8,
      },
      arbitrum: {},
    });

    expect(
      result.ethereum['0x1111111111111111111111111111111111111111']
        ?.wireDecimals,
    ).to.equal(8);
    expect(
      result.arbitrum['0x2222222222222222222222222222222222222222']
        ?.wireDecimals,
    ).to.equal(6);
  });

  it('normalizes chain-address map keys consistently with wire-decimal lookups', () => {
    const mixedCaseConfig: WarpCoreConfig = {
      tokens: [
        {
          chainName: 'ethereum',
          standard: TokenStandard.EvmHypCollateral,
          decimals: 18,
          symbol: 'ETH',
          name: 'Ether',
          addressOrDenom: '0xAbCdEf1111111111111111111111111111111111',
        },
      ],
    };

    const { warpRouteChainAddressMap } = buildWarpRouteMaps({
      'ETH/ethereum': mixedCaseConfig,
    });
    const normalizedAddress = normalizeAddress(
      '0xAbCdEf1111111111111111111111111111111111',
    );

    expect(
      warpRouteChainAddressMap.ethereum[normalizedAddress]?.addressOrDenom,
    ).to.equal('0xAbCdEf1111111111111111111111111111111111');

    const tokens = buildWarpRouteTokens(mixedCaseConfig);
    const wireDecimalsMap = buildWarpRouteWireDecimalsMap(tokens, {
      ethereum: {
        [normalizedAddress]: 8,
      },
    });

    expect(wireDecimalsMap.ethereum[normalizedAddress]?.wireDecimals).to.equal(
      8,
    );
  });
});
