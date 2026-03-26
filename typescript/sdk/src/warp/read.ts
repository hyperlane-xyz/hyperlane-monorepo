import type { Address } from '@hyperlane-xyz/utils';
import { normalizeAddress } from '@hyperlane-xyz/utils';

import type { ChainMap, ChainName } from '../types.js';
import type { TokenArgs } from '../token/ITokenMetadata.js';
import { TokenMetadata } from '../token/TokenMetadata.js';
import { parseTokenConnectionId } from '../token/TokenConnection.js';

import type { WarpCoreConfig } from './types.js';

export type TokenArgsWithWireDecimals = TokenArgs & { wireDecimals: number };

export type WarpRouteChainAddressMap = ChainMap<
  Record<Address, TokenArgsWithWireDecimals>
>;

export type WarpRouteIdToAddressesMap = Record<
  string,
  Array<{ chainName: string; address: Address }>
>;

export type WarpRouteConfigs = Record<string, WarpCoreConfig>;

export type WarpRouteWireDecimalsMap = Record<
  ChainName,
  Record<string, number>
>;

export function buildWarpRouteTokens(config: WarpCoreConfig): TokenMetadata[] {
  const tokens = config.tokens.map(
    (token) =>
      new TokenMetadata({
        ...token,
        addressOrDenom: token.addressOrDenom || '',
        connections: undefined,
      }),
  );

  config.tokens.forEach((tokenConfig, index) => {
    for (const connection of tokenConfig.connections || []) {
      const token = tokens[index];
      if (!token) throw new Error(`Token config missing at index ${index}`);

      const { chainName, addressOrDenom } = parseTokenConnectionId(
        connection.token,
      );
      const connectedToken = tokens.find(
        (candidate) =>
          candidate.chainName === chainName &&
          candidate.addressOrDenom === addressOrDenom &&
          (!token.warpRouteId || candidate.warpRouteId === token.warpRouteId),
      );

      if (!connectedToken) {
        throw new Error(
          `Connected token not found: ${chainName} ${addressOrDenom}`,
        );
      }

      token.addConnection({
        ...connection,
        token: connectedToken,
      });
    }
  });

  return tokens;
}

export function buildWarpRouteMaps(warpRouteConfigs: WarpRouteConfigs): {
  warpRouteChainAddressMap: WarpRouteChainAddressMap;
  warpRouteIdToAddressesMap: WarpRouteIdToAddressesMap;
  warpRouteConfigs: WarpRouteConfigs;
} {
  const warpRouteChainAddressMap: WarpRouteChainAddressMap = {};
  const warpRouteIdToAddressesMap: WarpRouteIdToAddressesMap = {};

  Object.entries(warpRouteConfigs).forEach(([routeId, { tokens }]) => {
    if (!tokens.length) return;

    const wireDecimals = Math.max(...tokens.map((t) => t.decimals ?? 18));
    const routeIdLower = routeId.toLowerCase();
    warpRouteIdToAddressesMap[routeIdLower] = [];

    tokens.forEach((token) => {
      const {
        chainName,
        addressOrDenom,
        connections: _connections,
        ...rest
      } = token;
      if (!addressOrDenom) return;

      warpRouteChainAddressMap[chainName] ||= {};
      warpRouteChainAddressMap[chainName][addressOrDenom] = {
        ...rest,
        addressOrDenom,
        chainName,
        wireDecimals,
      };
      warpRouteIdToAddressesMap[routeIdLower]?.push({
        chainName,
        address: addressOrDenom,
      });
    });
  });

  return {
    warpRouteChainAddressMap,
    warpRouteIdToAddressesMap,
    warpRouteConfigs,
  };
}

export function buildWarpRouteWireDecimalsMap(
  tokens: Array<
    Pick<TokenMetadata, 'addressOrDenom' | 'chainName' | 'decimals'>
  >,
  wireDecimalsMap: WarpRouteWireDecimalsMap,
): Record<ChainName, Record<string, { wireDecimals: number }>> {
  return tokens.reduce<
    Record<ChainName, Record<string, { wireDecimals: number }>>
  >((acc, token) => {
    if (!token.addressOrDenom) return acc;

    const normalizedAddress = normalizeAddress(token.addressOrDenom);
    const wireDecimals =
      wireDecimalsMap[token.chainName]?.[normalizedAddress] ?? token.decimals;

    acc[token.chainName] ||= {};
    acc[token.chainName][normalizedAddress] = { wireDecimals };
    return acc;
  }, {});
}
