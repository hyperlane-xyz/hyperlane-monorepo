import {
  AltVM,
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactNew,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedHookAddress,
  DeployedHookArtifact,
  HookArtifactConfig,
  HookConfig,
  IRawHookArtifactManager,
  hookConfigToArtifact,
  shouldDeployNewHook,
} from '@hyperlane-xyz/provider-sdk/hook';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { Address } from '@hyperlane-xyz/utils';

import { HookReader } from './generic-hook.js';

/**
 * Deployment context for hooks that need environment information.
 * Different protocols may require different context fields.
 */
export type HookDeploymentContext = {
  /** Mailbox address on the chain where hooks are being deployed */
  mailbox?: string;
};

/**
 * Factory function to create a HookWriter instance.
 *
 * @param chainMetadata Chain metadata for the target chain
 * @param chainLookup Chain lookup interface for resolving chain names and domain IDs
 * @param signer Signer interface for signing transactions
 * @param context Optional deployment context (mailbox address, etc.) required by some protocols
 * @returns A HookWriter instance
 *
 * @example
 * ```typescript
 * // Creating hooks during core deployment (with mailbox context)
 * const writer = createHookWriter(chainMetadata, chainLookup, signer, {
 *   mailbox: mailboxAddress
 * });
 * const [deployed] = await writer.create(hookArtifact);
 *
 * // Reading hooks (no context needed)
 * const reader = createHookReader(chainMetadata, chainLookup);
 * const hookConfig = await reader.deriveHookConfig(hookAddress);
 * ```
 */
export function createHookWriter(
  chainMetadata: ChainMetadataForAltVM,
  chainLookup: ChainLookup,
  signer: ISigner<AnnotatedTx, TxReceipt>,
  context?: HookDeploymentContext,
): HookWriter {
  const protocolProvider = getProtocolProvider(chainMetadata.protocol);
  const artifactManager: IRawHookArtifactManager =
    protocolProvider.createHookArtifactManager(chainMetadata, context);

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

  /**
   * Deploys a new hook or updates an existing one based on configuration comparison.
   *
   * This method encapsulates the logic to:
   * 1. If no existing hook, deploy a new one
   * 2. If existing hook exists, read its state and compare with expected config
   * 3. If configs differ significantly, deploy a new hook
   * 4. If configs can be updated in-place, generate update transactions
   *
   * @param params.actualAddress - The address of the existing hook (if any)
   * @param params.expectedConfig - The desired hook configuration
   * @returns Object with the deployed hook address and any update transactions
   */
  async deployOrUpdate(params: {
    actualAddress: string | undefined;
    expectedConfig: HookConfig;
  }): Promise<{
    address: Address;
    transactions: AnnotatedTx[];
  }> {
    const { actualAddress, expectedConfig } = params;

    // Convert expected config to artifact format
    const expectedArtifact = hookConfigToArtifact(
      expectedConfig,
      this.chainLookup,
    );

    // If no existing hook, deploy new one directly
    if (!actualAddress) {
      const [deployed] = await this.create(expectedArtifact);
      return {
        address: deployed.deployed.address,
        transactions: [],
      };
    }

    // Read actual hook state
    const actualArtifact = await this.read(actualAddress);

    // Decide: deploy new hook or update existing one
    if (shouldDeployNewHook(actualArtifact.config, expectedArtifact.config)) {
      // Deploy new hook
      const [deployed] = await this.create(expectedArtifact);
      return {
        address: deployed.deployed.address,
        transactions: [],
      };
    }

    // Update existing hook (only IGP hooks support updates)
    const deployedArtifact: DeployedHookArtifact = {
      ...expectedArtifact,
      artifactState: ArtifactState.DEPLOYED,
      config: expectedArtifact.config,
      deployed: actualArtifact.deployed,
    };
    const transactions = await this.update(deployedArtifact);

    return {
      address: actualAddress,
      transactions,
    };
  }
}
