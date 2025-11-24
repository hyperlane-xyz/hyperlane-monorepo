import type { DerivedHookConfig, HookConfig } from './hook.js';
import type { DerivedIsmConfig, IsmConfig } from './ism.js';

export type TokenRouterModuleType = {
  config: WarpConfig;
  derived: DerivedWarpConfig;
  addresses: WarpRouteAddresses;
};

export const TokenType = {
  synthetic: 'synthetic',
  collateral: 'collateral',
  native: 'native',
} as const;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export type RemoteRouters = Record<string, { address: string }>;
export type DestinationGas = Record<string, string>;

export interface BaseWarpConfig {
  owner: string;
  mailbox: string;
  interchainSecurityModule?: IsmConfig | string;
  hook?: HookConfig | string;
  remoteRouters?: RemoteRouters;
  destinationGas?: DestinationGas;
}

export interface CollateralWarpConfig extends BaseWarpConfig {
  type: 'collateral';
  token: string;
}

export interface SyntheticWarpConfig extends BaseWarpConfig {
  type: 'synthetic';
  name?: string;
  symbol?: string;
  decimals?: number;
}

export interface NativeWarpConfig extends BaseWarpConfig {
  type: 'native';
}

export type WarpConfig =
  | CollateralWarpConfig
  | SyntheticWarpConfig
  | NativeWarpConfig;

export interface BaseDerivedWarpConfig {
  owner: string;
  mailbox: string;
  interchainSecurityModule: DerivedIsmConfig | string;
  hook: DerivedHookConfig | string;
  remoteRouters: RemoteRouters;
  destinationGas: DestinationGas;
}

export interface DerivedCollateralWarpConfig extends BaseDerivedWarpConfig {
  type: 'collateral';
  token: string;
  name?: string;
  symbol?: string;
  decimals?: number;
}

export interface DerivedSyntheticWarpConfig extends BaseDerivedWarpConfig {
  type: 'synthetic';
  name?: string;
  symbol?: string;
  decimals?: number;
}

export interface DerivedNativeWarpConfig extends BaseDerivedWarpConfig {
  type: 'native';
}

export type DerivedWarpConfig =
  | DerivedCollateralWarpConfig
  | DerivedSyntheticWarpConfig
  | DerivedNativeWarpConfig;

export type WarpRouteAddresses = {
  deployedTokenRoute: string;
};
