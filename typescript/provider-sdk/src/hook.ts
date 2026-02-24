import {
  Logger,
  WithAddress,
  deepEquals,
  normalizeConfig,
  rootLogger,
} from '@hyperlane-xyz/utils';

import * as AltVM from './altvm.js';
import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactState,
  IArtifactManager,
} from './artifact.js';
import { ChainLookup } from './chain.js';

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

export function altVmHookTypeToProviderHookType(
  hookType: AltVM.HookType,
): HookType {
  switch (hookType) {
    case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
      return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
    case AltVM.HookType.MERKLE_TREE:
      return AltVM.HookType.MERKLE_TREE;
    default:
      throw new Error(`Unsupported hook type in provider API: ${hookType}`);
  }
}

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
export interface IRawHookArtifactManager extends IArtifactManager<
  HookType,
  RawHookArtifactConfigs,
  DeployedHookAddress
> {
  /**
   * Read any hook by detecting its type and delegating to the appropriate reader.
   * This is the generic entry point for reading hooks of unknown types.
   * @param address The on-chain address of the hook
   * @returns The artifact configuration and deployment data
   */
  readHook(address: string): Promise<DeployedHookArtifact>;
}

// Hook Config Utilities

const logger: Logger = rootLogger.child({ module: 'hook-config-utils' });

/**
 * Converts HookConfig (Config API) to HookArtifactConfig (Artifact API).
 *
 * Key transformations:
 * - IGP hooks: String chain names → numeric domain IDs for overhead/oracleConfig keys
 * - MerkleTree hooks: Pass through unchanged
 *
 * @param config The hook configuration using Config API format
 * @param chainLookup Chain lookup interface for resolving chain names to domain IDs
 * @returns Artifact wrapper around HookArtifactConfig suitable for artifact writers
 *
 * @example
 * ```typescript
 * // Config API format (user-facing)
 * const hookConfig: HookConfig = {
 *   type: 'interchainGasPaymaster',
 *   owner: '0x123...',
 *   overhead: {
 *     ethereum: 50000,
 *     polygon: 100000
 *   },
 *   oracleConfig: {
 *     ethereum: { gasPrice: '10', tokenExchangeRate: '1' },
 *     polygon: { gasPrice: '50', tokenExchangeRate: '1.5' }
 *   }
 * };
 *
 * // Convert to Artifact API format (internal)
 * const artifact = hookConfigToArtifact(hookConfig, chainLookup);
 * // artifact.config.overhead is now Record<number, number> with domain IDs as keys
 * // artifact.config.oracleConfig is now Record<number, {...}> with domain IDs as keys
 * ```
 */
export function hookConfigToArtifact(
  config: HookConfig,
  chainLookup: ChainLookup,
): ArtifactNew<HookArtifactConfig> {
  switch (config.type) {
    case 'interchainGasPaymaster': {
      // Handle IGP hooks - need to convert chain names to domain IDs
      const overhead: Record<number, number> = {};
      const oracleConfig: Record<
        number,
        {
          gasPrice: string;
          tokenExchangeRate: string;
          tokenDecimals?: number;
        }
      > = {};

      // Convert overhead map from chain names to domain IDs
      for (const [chainName, value] of Object.entries(config.overhead)) {
        const domainId = chainLookup.getDomainId(chainName);
        if (domainId === null) {
          logger.warn(
            `Skipping overhead config for unknown chain: ${chainName}. ` +
              `Chain not found in chain lookup.`,
          );
          continue;
        }
        overhead[domainId] = value;
      }

      // Convert oracleConfig map from chain names to domain IDs
      for (const [chainName, value] of Object.entries(config.oracleConfig)) {
        const domainId = chainLookup.getDomainId(chainName);
        if (domainId === null) {
          logger.warn(
            `Skipping oracle config for unknown chain: ${chainName}. ` +
              `Chain not found in chain lookup.`,
          );
          continue;
        }
        oracleConfig[domainId] = value;
      }

      return {
        artifactState: ArtifactState.NEW,
        config: {
          type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: config.owner,
          beneficiary: config.beneficiary,
          oracleKey: config.oracleKey,
          overhead,
          oracleConfig,
        },
      };
    }

    case 'merkleTreeHook':
      // MerkleTree hooks have identical structure between Config API and Artifact API
      return {
        artifactState: ArtifactState.NEW,
        config: {
          type: AltVM.HookType.MERKLE_TREE,
        },
      };

    default: {
      throw new Error(`Unhandled hook type: ${(config as any).type}`);
    }
  }
}

/**
 * Determines if a new hook should be deployed instead of updating the existing one.
 * Deploy new hook if:
 * - Hook type changed
 * - Hook config changed (for immutable hooks like MerkleTree)
 *
 * For mutable hooks (IGP), they can be updated in-place.
 *
 * @param actual The current deployed hook configuration
 * @param expected The desired hook configuration
 * @returns true if a new hook should be deployed, false if existing can be updated
 */
export function shouldDeployNewHook(
  actual: HookArtifactConfig,
  expected: HookArtifactConfig,
): boolean {
  // Type changed - must deploy new
  if (actual.type !== expected.type) return true;

  // Normalize and compare configs
  const normalizedActual = normalizeConfig(actual);
  const normalizedExpected = normalizeConfig(expected);

  // Check mutability based on hook type
  switch (expected.type) {
    case AltVM.HookType.MERKLE_TREE:
      // MerkleTree hooks are immutable - must deploy new if config changed
      return !deepEquals(normalizedActual, normalizedExpected);

    case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
      // IGP hooks are mutable - can be updated
      return false;

    default: {
      throw new Error(`Unhandled hook type: ${(expected as any).type}`);
    }
  }
}

/**
 * Converts a DeployedHookArtifact to DerivedHookConfig format.
 * This handles the conversion between the new Artifact API and the old Config API.
 *
 * @param artifact The deployed hook artifact from the Artifact API
 * @param chainLookup Chain lookup interface for resolving domain IDs to chain names
 * @returns Hook configuration in Config API format with address
 */
export function hookArtifactToDerivedConfig(
  artifact: DeployedHookArtifact,
  chainLookup: ChainLookup,
): DerivedHookConfig {
  const config = artifact.config;
  const address = artifact.deployed.address;

  switch (config.type) {
    case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER: {
      // For IGP hooks, convert domain IDs back to chain names
      const overhead: Record<string, number> = {};
      const oracleConfig: Record<
        string,
        {
          gasPrice: string;
          tokenExchangeRate: string;
          tokenDecimals?: number;
        }
      > = {};

      for (const [domainIdStr, value] of Object.entries(config.overhead)) {
        const domainId = parseInt(domainIdStr);
        const chainName = chainLookup.getChainName(domainId);
        if (!chainName) {
          // Skip unknown domains (already warned during read if needed)
          continue;
        }
        overhead[chainName] = value;
      }

      for (const [domainIdStr, value] of Object.entries(config.oracleConfig)) {
        const domainId = parseInt(domainIdStr);
        const chainName = chainLookup.getChainName(domainId);
        if (!chainName) {
          // Skip unknown domains
          continue;
        }
        oracleConfig[chainName] = value;
      }

      return {
        type: 'interchainGasPaymaster',
        owner: config.owner,
        beneficiary: config.beneficiary,
        oracleKey: config.oracleKey,
        overhead,
        oracleConfig,
        address,
      };
    }

    case AltVM.HookType.MERKLE_TREE:
      // For MerkleTree hooks, just add the address
      return {
        ...config,
        address,
      };

    default: {
      throw new Error(`Unhandled hook type: ${(config as any).type}`);
    }
  }
}
