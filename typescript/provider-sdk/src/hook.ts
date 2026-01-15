import { WithAddress } from '@hyperlane-xyz/utils';

import {
  ArtifactDeployed,
  ArtifactOnChain,
  ArtifactState,
  IArtifactManager,
} from './artifact.js';

export type HookModuleType = {
  config: HookConfig;
  derived: DerivedHookConfig;
  addresses: HookModuleAddresses;
};

export interface HookConfigs {
  interchainGasPaymaster: IgpHookModuleConfig;
  merkleTreeHook: MerkleTreeHookConfig;
}
export type HookType = keyof HookConfigs;
export type HookConfig = HookConfigs[HookType];
export type DerivedHookConfig = WithAddress<HookConfig>;

export const MUTABLE_HOOK_TYPE: HookType[] = [
  'interchainGasPaymaster',
  // 'protocolFee',
  // 'domainRoutingHook',
  // 'fallbackRoutingHook',
  // 'pausableHook',
];

export interface IgpHookModuleConfig {
  type: 'interchainGasPaymaster';
  owner: string;
  beneficiary: string;
  oracleKey: string;
  overhead: Record<string, number>;
  oracleConfig: Record<
    string,
    {
      gasPrice: string;
      tokenExchangeRate: string;
      tokenDecimals?: number;
    }
  >;
}

export interface MerkleTreeHookConfig {
  type: 'merkleTreeHook';
}

export type HookModuleAddresses = {
  deployedHook: string;
  mailbox: string;
};

// Artifact API types

export interface DeployedHookAddress {
  address: string;
}

/**
 * IGP Hook config for Artifact API.
 * Uses domain IDs (numbers) instead of chain names (strings) for overhead and oracleConfig keys.
 * This differs from IgpHookModuleConfig which uses chain names for the Config API.
 */
export interface IgpHookConfig {
  type: 'interchainGasPaymaster';
  owner: string;
  beneficiary: string;
  oracleKey: string;
  overhead: Record<number, number>;
  oracleConfig: Record<
    number,
    {
      gasPrice: string;
      tokenExchangeRate: string;
      tokenDecimals?: number;
    }
  >;
}

export interface HookArtifactConfigs {
  interchainGasPaymaster: IgpHookConfig;
  merkleTreeHook: MerkleTreeHookConfig;
}

/**
 * Should be used for the specific artifact code that
 * deploys or reads any kind of Hook
 */
export type HookArtifactConfig = HookArtifactConfigs[HookType];

/**
 * Describes the configuration of deployed Hook
 */
export type DeployedHookArtifact = ArtifactDeployed<
  HookArtifactConfig,
  DeployedHookAddress
>;

/**
 * Should be used to implement an object/closure or class that is in charge of coordinating
 * deployment of a Hook config
 */
export type IHookArtifactManager = IArtifactManager<
  HookType,
  HookArtifactConfigs,
  DeployedHookAddress
>;

/**
 * Raw hook artifact configs (no nested artifacts for now, but kept for consistency)
 */
export interface RawHookArtifactConfigs {
  interchainGasPaymaster: IgpHookConfig;
  merkleTreeHook: MerkleTreeHookConfig;
}

/**
 * Should be used for the specific artifact code that
 * deploys or reads a single hook artifact on chain
 */
export type RawHookArtifactConfig = RawHookArtifactConfigs[HookType];

/**
 * Should be used to implement an object/closure or class that individually deploys
 * Hooks on chain
 */
export type IRawHookArtifactManager = IArtifactManager<
  HookType,
  RawHookArtifactConfigs,
  DeployedHookAddress
>;

export function hookOnChainAddress(
  hook: ArtifactOnChain<HookArtifactConfig, DeployedHookAddress>,
): string {
  return hook.artifactState === ArtifactState.DEPLOYED
    ? hook.deployed.address
    : hook.deployed.address;
}
