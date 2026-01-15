import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactNew,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  HookArtifactConfig,
  HookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';
import { Logger, rootLogger } from '@hyperlane-xyz/utils';

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
  // Handle IGP hooks - need to convert chain names to domain IDs
  if (config.type === 'interchainGasPaymaster') {
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

  // MerkleTree hooks have identical structure between Config API and Artifact API
  return {
    artifactState: ArtifactState.NEW,
    config: {
      type: AltVM.HookType.MERKLE_TREE,
    },
  };
}

/**
 * Determines if a new hook should be deployed instead of updating the existing one.
 * Deploy new hook if:
 * - Hook type changed
 * - Hook is immutable (MerkleTree)
 *
 * Only IGP hooks are mutable and support updates.
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

  // MerkleTree hooks are immutable - must deploy new
  if (expected.type === AltVM.HookType.MERKLE_TREE) return true;

  // IGP hooks are mutable - can be updated
  return false;
}
