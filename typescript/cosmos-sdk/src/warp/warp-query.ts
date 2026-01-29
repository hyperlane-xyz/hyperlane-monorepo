import { type QueryClient } from '@cosmjs/stargate';

import { warpTypes } from '@hyperlane-xyz/cosmos-types';
import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert } from '@hyperlane-xyz/utils';

import { type WarpExtension } from '../hyperlane/warp/query.js';
import {
  type CosmosCollateralWarpTokenConfig,
  type CosmosSyntheticWarpTokenConfig,
} from '../utils/types.js';

export type CosmosWarpQueryClient = QueryClient & WarpExtension;

export async function getWarpTokenType(
  query: CosmosWarpQueryClient,
  tokenAddress: string,
): Promise<AltVM.TokenType> {
  try {
    const { token } = await query.warp.Token({
      id: tokenAddress,
    });
    assert(token, `No token found at address ${tokenAddress}`);

    // Map Cosmos token type to provider-sdk TokenType with exhaustiveness check
    switch (token.token_type) {
      case warpTypes.HypTokenType.HYP_TOKEN_TYPE_COLLATERAL:
        return AltVM.TokenType.collateral;
      case warpTypes.HypTokenType.HYP_TOKEN_TYPE_SYNTHETIC:
        return AltVM.TokenType.synthetic;
      case warpTypes.HypTokenType.HYP_TOKEN_TYPE_UNSPECIFIED:
        throw new Error('Token type is unspecified');
      case warpTypes.HypTokenType.UNRECOGNIZED:
        throw new Error('Token type is unrecognized');
      default: {
        // Exhaustiveness check: if a new token type is added, this will cause a compile error
        const _exhaustiveCheck: never = token.token_type;
        throw new Error(`Unknown token type: ${_exhaustiveCheck}`);
      }
    }
  } catch (error) {
    throw new Error(
      `Failed to query token type at ${tokenAddress}: ${(error as Error).message}`,
    );
  }
}

async function getRemoteRoutersAndGas(
  query: CosmosWarpQueryClient,
  tokenAddress: string,
): Promise<{
  remoteRouters: Record<number, { address: string }>;
  destinationGas: Record<number, string>;
}> {
  const { remote_routers } = await query.warp.RemoteRouters({
    id: tokenAddress,
  });

  const remoteRouters: Record<number, { address: string }> = {};
  const destinationGas: Record<number, string> = {};

  for (const router of remote_routers) {
    remoteRouters[router.receiver_domain] = {
      address: router.receiver_contract,
    };
    destinationGas[router.receiver_domain] = router.gas;
  }

  return { remoteRouters, destinationGas };
}

export async function getCollateralWarpTokenConfig(
  query: CosmosWarpQueryClient,
  tokenAddress: string,
): Promise<CosmosCollateralWarpTokenConfig> {
  try {
    const { token } = await query.warp.Token({
      id: tokenAddress,
    });
    assert(token, `No token found at address ${tokenAddress}`);
    assert(
      token.token_type === warpTypes.HypTokenType.HYP_TOKEN_TYPE_COLLATERAL,
      `Token at ${tokenAddress} is not a collateral token`,
    );

    const { remoteRouters, destinationGas } = await getRemoteRoutersAndGas(
      query,
      tokenAddress,
    );

    return {
      type: AltVM.TokenType.collateral,
      address: token.id,
      owner: token.owner,
      mailbox: token.origin_mailbox,
      interchainSecurityModule: token.ism_id,
      token: token.origin_denom,
      name: '',
      symbol: '',
      decimals: 0,
      remoteRouters,
      destinationGas,
    };
  } catch (error) {
    throw new Error(
      `Failed to query collateral token config at ${tokenAddress}: ${(error as Error).message}`,
    );
  }
}

export async function getSyntheticWarpTokenConfig(
  query: CosmosWarpQueryClient,
  tokenAddress: string,
): Promise<CosmosSyntheticWarpTokenConfig> {
  try {
    const { token } = await query.warp.Token({
      id: tokenAddress,
    });
    assert(token, `No token found at address ${tokenAddress}`);
    assert(
      token.token_type === warpTypes.HypTokenType.HYP_TOKEN_TYPE_SYNTHETIC,
      `Token at ${tokenAddress} is not a synthetic token`,
    );

    const { remoteRouters, destinationGas } = await getRemoteRoutersAndGas(
      query,
      tokenAddress,
    );

    return {
      type: AltVM.TokenType.synthetic,
      address: token.id,
      owner: token.owner,
      mailbox: token.origin_mailbox,
      interchainSecurityModule: token.ism_id,
      name: '',
      symbol: '',
      decimals: 0,
      remoteRouters,
      destinationGas,
    };
  } catch (error) {
    throw new Error(
      `Failed to query synthetic token config at ${tokenAddress}: ${(error as Error).message}`,
    );
  }
}
