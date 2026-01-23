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
  DeployedIsmAddress,
  DeployedIsmArtifact,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';

import { IsmReader } from './generic-ism.js';
import { RoutingIsmWriter } from './routing-ism.js';

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
export async function createIsmWriter(
  chainMetadata: ChainMetadataForAltVM,
  chainLookup: ChainLookup,
  signer: ISigner<AnnotatedTx, TxReceipt>,
): Promise<IsmWriter> {
  const protocolProvider = getProtocolProvider(chainMetadata.protocol);
  const artifactManager: IRawIsmArtifactManager =
    await protocolProvider.createIsmArtifactManager(chainMetadata);

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
    const { artifactState, config } = artifact;

    // Routing ISMs are composite - use RoutingIsmWriter for nested deployments
    if (config.type === AltVM.IsmType.ROUTING) {
      return this.routingWriter.create({ artifactState, config });
    }

    // For other ISM types, request typed writer from artifact manager
    const writer = this.artifactManager.createWriter(config.type, this.signer);
    return writer.create({ artifactState, config });
  }

  /**
   * Updates an existing ISM to match the desired configuration.
   * Only routing ISMs support updates (domain enrollment/unenrollment, owner changes).
   * Multisig and test ISMs are immutable - returns empty array.
   *
   * @param artifact The desired ISM state (must include deployed address)
   * @returns Array of transactions needed to perform the update
   */
  async update(artifact: DeployedIsmArtifact): Promise<AnnotatedTx[]> {
    const { artifactState, config, deployed } = artifact;

    // Only routing ISMs are mutable - support domain updates and owner changes
    if (config.type === AltVM.IsmType.ROUTING) {
      return this.routingWriter.update({ artifactState, config, deployed });
    }

    // Multisig and test ISMs are immutable - no updates possible
    return [];
  }
}
