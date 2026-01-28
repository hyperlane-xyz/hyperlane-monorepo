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
  DeployedIsmAddress,
  DeployedIsmArtifact,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
  STATIC_ISM_TYPES,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { deepEquals } from '@hyperlane-xyz/utils';

import { IsmReader } from './generic-ism.js';
import { ApplyUpdateResult, RoutingIsmWriter } from './routing-ism.js';

/**
 * Factory function to create an IsmWriter instance.
 * This helper centralizes the creation of artifact managers and ISM writers,
 * making it easier to instantiate writers across the codebase.
 *
 * @param chainMetadata Chain metadata for the target chain (protocol type is extracted from metadata.protocol)
 * @param chainLookup Chain lookup interface for resolving chain names and domain IDs
 * @param signer Signer interface for signing transactions
 * @returns An IsmWriter instance
 *
 * @example
 * ```typescript
 * const writer = createIsmWriter(chainMetadata, chainLookup, signer);
 * const [deployed, receipts] = await writer.create({ config: ismConfig });
 * ```
 */
export function createIsmWriter(
  chainMetadata: ChainMetadataForAltVM,
  chainLookup: ChainLookup,
  signer: ISigner<AnnotatedTx, TxReceipt>,
): IsmWriter {
  const protocolProvider = getProtocolProvider(chainMetadata.protocol);
  const artifactManager: IRawIsmArtifactManager =
    protocolProvider.createIsmArtifactManager(chainMetadata);

  return new IsmWriter(artifactManager, chainLookup, signer);
}

/**
 * IsmWriter handles creation and updates of ISMs using the Artifact API.
 * It delegates to protocol-specific artifact writers for individual ISM types.
 *
 * Key features:
 * - Extends IsmReader to inherit read() functionality
 * - Works with pure Artifact API (IsmArtifactConfig)
 * - Delegates to typed writers from artifact manager for specific ISM types
 * - Uses RoutingIsmWriter for composite routing ISM operations
 * - Protocol-agnostic through artifact manager abstraction
 */
export class IsmWriter
  extends IsmReader
  implements ArtifactWriter<IsmArtifactConfig, DeployedIsmAddress>
{
  private readonly routingWriter: RoutingIsmWriter;

  constructor(
    protected readonly artifactManager: IRawIsmArtifactManager,
    protected readonly chainLookup: ChainLookup,
    protected readonly signer: ISigner<AnnotatedTx, TxReceipt>,
  ) {
    super(artifactManager, chainLookup);
    this.routingWriter = new RoutingIsmWriter(
      artifactManager,
      chainLookup,
      signer,
      this, // Pass this IsmWriter for nested ISM operations
    );
  }

  /**
   * Creates a new ISM by deploying it on-chain.
   * For routing ISMs, delegates to RoutingIsmWriter to handle nested ISM deployments.
   * For other ISM types, requests a typed writer from the artifact manager.
   *
   * @param artifact The ISM configuration to deploy (can be new or reference existing)
   * @returns A tuple of [deployed artifact, transaction receipts]
   */
  async create(
    artifact: ArtifactNew<IsmArtifactConfig>,
  ): Promise<[DeployedIsmArtifact, TxReceipt[]]> {
    const { config } = artifact;

    // Routing ISMs are composite - use RoutingIsmWriter for nested deployments
    if (config.type === AltVM.IsmType.ROUTING) {
      return this.routingWriter.create({ ...artifact, config });
    }

    // For other ISM types, request typed writer from artifact manager
    const writer = this.artifactManager.createWriter(config.type, this.signer);
    return writer.create({ ...artifact, config });
  }

  /**
   * Updates an existing ISM to match the desired configuration.
   *
   * Behavior depends on ISM type and config changes:
   * - Type changed: creates new ISM (returns empty txs - address change requires setIsm call)
   * - Immutable type (multisig), config unchanged: no-op
   * - Immutable type (multisig), config changed: creates new ISM (returns empty txs)
   * - Mutable type (routing), any change: delegates to type-specific update
   *
   * @param artifact The desired ISM state (must include deployed address)
   * @returns Array of transactions needed to perform the update
   */
  async update(artifact: DeployedIsmArtifact): Promise<AnnotatedTx[]> {
    const result = await this.applyUpdate(artifact.deployed.address, {
      config: artifact.config,
    });

    // Return transactions only for 'update' action
    // For 'create' and 'noop', return empty array (backward compatible)
    return result.action === 'update' ? result.txs : [];
  }

  /**
   * Applies an update to an ISM, returning the result with proper address tracking.
   *
   * This method consolidates update logic and properly communicates:
   * - What action was taken (noop, create, update)
   * - The correct deployed address (which may be different if a new ISM was created)
   * - Any transactions that need to be executed
   *
   * Use this method instead of update() when you need to know the resulting address,
   * e.g., when updating nested ISMs in a routing ISM.
   *
   * @param currentAddress The address of the currently deployed ISM
   * @param desired The desired ISM configuration
   * @returns The result of the update operation with action type and deployed address
   */
  async applyUpdate(
    currentAddress: string,
    desired: ArtifactNew<IsmArtifactConfig>,
  ): Promise<ApplyUpdateResult> {
    const { config } = desired;

    // Read current on-chain config
    const currentArtifact = await this.artifactManager.readIsm(currentAddress);
    const currentConfig = currentArtifact.config;

    // Type changed - must create new ISM
    if (currentConfig.type !== config.type) {
      const [deployed, receipts] = await this.create(desired);
      return { action: 'create', deployed, receipts };
    }

    // For immutable (static) ISM types, compare configs
    if (STATIC_ISM_TYPES.includes(config.type)) {
      if (deepEquals(currentConfig, config)) {
        // Config unchanged - no-op
        return {
          action: 'noop',
          deployed: {
            artifactState: ArtifactState.DEPLOYED,
            config: currentConfig,
            deployed: { address: currentAddress },
          },
        };
      }
      // Config changed - create new ISM
      const [deployed, receipts] = await this.create(desired);
      return { action: 'create', deployed, receipts };
    }

    // Mutable types (routing) - delegate to type-specific update
    if (config.type === AltVM.IsmType.ROUTING) {
      const deployedArtifact: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config,
        deployed: { address: currentAddress },
      };
      const txs = await this.routingWriter.update({
        ...deployedArtifact,
        config,
      });
      return { action: 'update', deployed: deployedArtifact, txs };
    }

    // Unknown mutable type - no-op
    return {
      action: 'noop',
      deployed: {
        artifactState: ArtifactState.DEPLOYED,
        config: currentConfig,
        deployed: { address: currentAddress },
      },
    };
  }
}
