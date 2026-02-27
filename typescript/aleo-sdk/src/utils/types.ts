import {
  type ConfirmedTransactionJSON,
  type ExecuteOptions,
} from '@provablehq/sdk';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { type RawWarpArtifactConfig } from '@hyperlane-xyz/provider-sdk/warp';
import { type Annotated } from '@hyperlane-xyz/utils';

export interface AleoTransaction extends ExecuteOptions {}
export type AnnotatedAleoTransaction = Annotated<AleoTransaction>;
export interface AleoReceipt extends ConfirmedTransactionJSON {
  transactionHash: string;
}

export enum AleoTokenType {
  NATIVE = 0,
  SYNTHETIC = 1,
  COLLATERAL = 2,
}

export enum AleoHookType {
  CUSTOM = 0,
  MERKLE_TREE = 3,
  INTERCHAIN_GAS_PAYMASTER = 4,
  PAUSABLE = 7,
}

// This must be kept in sync with the enum at
// https://github.com/hyperlane-xyz/hyperlane-aleo/blob/50b9d0ba107939bf3d8f634d302fbd7db922165a/ism_manager/src/main.leo#L71-L74
export enum AleoIsmType {
  TEST_ISM = 6,
  ROUTING = 1,
  MERKLE_ROOT_MULTISIG = 4,
  MESSAGE_ID_MULTISIG = 5,
}

export const AleoNetworkId = {
  MAINNET: 0,
  TESTNET: 1,
} as const;

export type AleoNetworkId = (typeof AleoNetworkId)[keyof typeof AleoNetworkId];

/**
 * Internal Aleo-specific warp token configuration types.
 * These are used by query and transaction functions, and converted to/from
 * provider-sdk artifact types by reader/writer implementations.
 */

interface BaseAleoWarpTokenConfig {
  owner: string;
  mailbox: string;
  ism?: string;
  hook?: string;
  remoteRouters: Record<
    number,
    {
      address: string;
      gas: string;
    }
  >;
}

export interface AleoNativeWarpTokenConfig extends BaseAleoWarpTokenConfig {
  type: AleoTokenType.NATIVE;
}

export interface AleoCollateralWarpTokenConfig extends BaseAleoWarpTokenConfig {
  type: AleoTokenType.COLLATERAL;
  token: string;
  name: string;
  symbol: string;
  decimals: number;
}

export interface AleoSyntheticWarpTokenConfig extends BaseAleoWarpTokenConfig {
  type: AleoTokenType.SYNTHETIC;
  name: string;
  symbol: string;
  decimals: number;
}

export type AleoWarpTokenConfig =
  | AleoNativeWarpTokenConfig
  | AleoCollateralWarpTokenConfig
  | AleoSyntheticWarpTokenConfig;

export interface OnChainArtifactManagers {
  ismManagerAddress: string;
  hookManagerAddress: string;
}

/**
 * Transform Aleo warp token's common fields to provider-sdk artifact format.
 * Handles ISM, remote routers, and destination gas transformations that are
 * identical across all token types.
 */
export function aleoWarpFieldsToArtifactApi(
  token: Pick<AleoWarpTokenConfig, 'ism' | 'remoteRouters' | 'hook'>,
): Pick<
  RawWarpArtifactConfig,
  'interchainSecurityModule' | 'hook' | 'remoteRouters' | 'destinationGas'
> {
  return {
    interchainSecurityModule: token.ism
      ? {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: token.ism,
          },
        }
      : undefined,
    hook: token.hook
      ? {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: token.hook,
          },
        }
      : undefined,
    remoteRouters: Object.fromEntries(
      Object.entries(token.remoteRouters).map(([domainId, router]) => [
        domainId,
        { address: router.address },
      ]),
    ),
    destinationGas: Object.fromEntries(
      Object.entries(token.remoteRouters).map(([domainId, router]) => [
        domainId,
        router.gas,
      ]),
    ),
  };
}
