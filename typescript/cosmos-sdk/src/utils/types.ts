import { type EncodeObject } from '@cosmjs/proto-signing';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import { type Annotated } from '@hyperlane-xyz/utils';

/**
 * Cosmos transaction with optional annotation field.
 * This type satisfies the AnnotatedTx interface required by the generic artifact API.
 */
export type AnnotatedEncodeObject = Annotated<EncodeObject>;

/**
 * Base warp token configuration shared by all token types.
 * Note: Cosmos doesn't store name/symbol/decimals on-chain, so these are provided
 * as empty/zero values for consistency with other chains.
 */
export interface BaseCosmosWarpTokenConfig {
  address: string;
  owner: string;
  mailbox: string;
  interchainSecurityModule?: string;
  hookAddress?: string;
  remoteRouters: Record<number, { address: string }>;
  destinationGas: Record<number, string>;
  name: string; // empty string on Cosmos
  symbol: string; // empty string on Cosmos
  decimals: number; // 0 on Cosmos
}

export interface CosmosCollateralWarpTokenConfig
  extends BaseCosmosWarpTokenConfig {
  type: AltVM.TokenType.collateral;
  token: string; // origin denom
}

export interface CosmosSyntheticWarpTokenConfig
  extends BaseCosmosWarpTokenConfig {
  type: AltVM.TokenType.synthetic;
}

export type CosmosWarpTokenConfig =
  | CosmosCollateralWarpTokenConfig
  | CosmosSyntheticWarpTokenConfig;
