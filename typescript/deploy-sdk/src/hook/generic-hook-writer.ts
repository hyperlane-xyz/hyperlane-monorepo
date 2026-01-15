import {
  AltVM,
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactNew,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedHookAddress,
  DeployedHookArtifact,
  HookArtifactConfig,
  IRawHookArtifactManager,
} from '@hyperlane-xyz/provider-sdk/hook';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';

import { HookReader } from './generic-hook.js';

/**
 * Factory function to create a HookWriter instance.
 *
 * Note: For protocols that require deployment context (mailbox, nativeTokenDenom),
 * you must create the artifact manager manually with the required context.
 * This factory uses the protocol provider which may not have access to deployment context.
 *
 * @param chainMetadata Chain metadata for the target chain
 * @param chainLookup Chain lookup interface for resolving chain names and domain IDs
 * @param signer Signer interface for signing transactions
 * @param context Optional deployment context (mailbox address, native token denom) for hook writers
 * @returns A HookWriter instance
 *
 * @example
 * ```typescript
 * // For Radix, create artifact manager manually with deployment context
 * const artifactManager = new RadixHookArtifactManager(
 *   gateway,
 *   base,
 *   mailboxAddress,  // from deployment
 *   nativeTokenDenom // from chain metadata
 * );
 * const writer = new HookWriter(artifactManager, chainLookup, signer);
 *
 * // Or use factory for reading-only operations
 * const writer = createHookWriter(chainMetadata, chainLookup, signer);
 * ```
 */
export function createHookWriter(
  chainMetadata: ChainMetadataForAltVM,
  chainLookup: ChainLookup,
  signer: ISigner<AnnotatedTx, TxReceipt>,
): HookWriter {
  const protocolProvider = getProtocolProvider(chainMetadata.protocol);
  const artifactManager: IRawHookArtifactManager =
    protocolProvider.createHookArtifactManager(chainMetadata);

  return new HookWriter(artifactManager, chainLookup, signer);
}

/**
 * HookWriter handles creation and updates of hooks using the Artifact API.
 * It delegates to protocol-specific artifact writers for individual hook types.
 *
 * Key features:
 * - Extends HookReader to inherit read() functionality
 * - Works with pure Artifact API (HookArtifactConfig)
 * - Delegates to typed writers from artifact manager for specific hook types
 * - Protocol-agnostic through artifact manager abstraction
 * - Supports IGP hook updates (gas configs, owner changes)
 * - MerkleTree hooks are immutable (no updates)
 *
 * Note: In the future, the Artifact API will include an explicit check
 * to verify if an artifact type is updatable before attempting updates.
 */
export class HookWriter
  extends HookReader
  implements ArtifactWriter<HookArtifactConfig, DeployedHookAddress>
{
  constructor(
    protected readonly artifactManager: IRawHookArtifactManager,
    protected readonly chainLookup: ChainLookup,
    protected readonly signer: ISigner<AnnotatedTx, TxReceipt>,
  ) {
    super(artifactManager, chainLookup);
  }

  /**
   * Creates a new hook by deploying it on-chain.
   * Delegates to the typed writer from the artifact manager based on hook type.
   *
   * @param artifact The hook configuration to deploy
   * @returns A tuple of [deployed artifact, transaction receipts]
   */
  async create(
    artifact: ArtifactNew<HookArtifactConfig>,
  ): Promise<[DeployedHookArtifact, TxReceipt[]]> {
    const { config } = artifact;

    // Get the typed writer for this hook type
    const writer = this.artifactManager.createWriter(config.type, this.signer);
    return writer.create(artifact);
  }

  /**
   * Updates an existing hook to match the desired configuration.
   * Only IGP hooks support updates (gas config changes, owner changes).
   * MerkleTree hooks are immutable - returns empty array.
   *
   * Note: In the future, the Artifact API will provide an explicit
   * isUpdatable() check to determine if an artifact can be updated.
   *
   * @param artifact The desired hook state (must include deployed address)
   * @returns Array of transactions needed to perform the update
   */
  async update(artifact: DeployedHookArtifact): Promise<AnnotatedTx[]> {
    const { artifactState, config, deployed } = artifact;

    // Only IGP hooks are mutable - support gas config and owner updates
    if (config.type === AltVM.HookType.INTERCHAIN_GAS_PAYMASTER) {
      const writer = this.artifactManager.createWriter(
        config.type,
        this.signer,
      );
      // Type assertion is safe here because we've checked the type above
      return writer.update({ artifactState, config, deployed });
    }

    // MerkleTree hooks are immutable - no updates possible
    return [];
  }
}
