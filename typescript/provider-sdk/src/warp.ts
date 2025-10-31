import type { DerivedHookConfig, HookConfig } from './hook.js';
import type { DerivedIsmConfig, IsmConfig } from './ism.js';

export const TokenType = {
  synthetic: 'synthetic',
  collateral: 'collateral',
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

export type WarpConfig = CollateralWarpConfig | SyntheticWarpConfig;

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

export type DerivedWarpConfig =
  | DerivedCollateralWarpConfig
  | DerivedSyntheticWarpConfig;
