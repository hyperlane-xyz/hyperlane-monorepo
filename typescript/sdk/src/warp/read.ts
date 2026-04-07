import type { Address } from '@hyperlane-xyz/utils';

import type { ChainMap } from '../types.js';
import type { TokenArgs } from '../token/ITokenMetadata.js';

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
      const tokenArgs: TokenArgsWithWireDecimals = {
        ...rest,
        chainName,
        addressOrDenom,
        wireDecimals,
      };
      warpRouteChainAddressMap[chainName][addressOrDenom] = tokenArgs;

      warpRouteIdToAddressesMap[routeIdLower].push({
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
