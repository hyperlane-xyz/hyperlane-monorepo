import {
  AltVM,
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactComposition,
  ArtifactDeployed,
  ArtifactNew,
  ConfigOnChain,
  OrchestratedArtifactWriter,
  WithCompositionVariant,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddress,
  DeployedIsmArtifact,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
  RoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { assert } from '@hyperlane-xyz/utils';

import { IsmReader } from './generic-ism.js';
import { RoutingIsmWriter } from './routing-ism.js';

type OrchestratedIsmArtifactConfig = WithCompositionVariant<
  IsmArtifactConfig,
  typeof ArtifactComposition.ORCHESTRATED
>;

/**
 * Post-deploy on-chain shape: ORCHESTRATED ISM with composite children
 * collapsed via `ConfigOnChain`. Matches the
 * `OrchestratedArtifactWriter<IsmArtifactConfig, D>.create()` return.
 */
type OrchestratedDeployedIsmArtifact = ArtifactDeployed<
  ConfigOnChain<OrchestratedIsmArtifactConfig, DeployedIsmAddress>,
  DeployedIsmAddress
>;

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
  implements OrchestratedArtifactWriter<IsmArtifactConfig, DeployedIsmAddress>
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
  ): Promise<[OrchestratedDeployedIsmArtifact, TxReceipt[]]> {
    const { artifactState, config } = artifact;

    // Routing ISMs are composite — use RoutingIsmWriter for nested
    // deployments. EMBEDDED routing dispatch via this generic writer is
    // deferred; the SVM EMBEDDED routing-multisig writer is invoked
    // directly by callers wiring cross-VM core deploys (the deploy-sdk
    // here only handles ORCHESTRATED until `DeployedIsmArtifact` is
    // widened to carry post-collapse EMBEDDED children).
    if (config.type === AltVM.IsmType.ROUTING) {
      const rawWriter = this.artifactManager.createWriter(
        AltVM.IsmType.ROUTING,
        this.signer,
      );
      assert(
        rawWriter.composition === ArtifactComposition.ORCHESTRATED,
        `Routing ISM composition mismatch: '${config.composition}' config cannot be created by a '${rawWriter.composition}' raw routing-ISM writer`,
      );
      assert(
        config.composition === ArtifactComposition.ORCHESTRATED,
        `Routing ISM composition mismatch: orchestrated writer cannot create an '${config.composition}' config`,
      );
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

    // Only routing ISMs are mutable - support domain updates and owner changes.
    // EMBEDDED routing dispatch via this generic writer is deferred (see
    // `create` above and `IsmReader.read`); callers driving SVM EMBEDDED
    // updates invoke the raw writer directly until `DeployedIsmArtifact`
    // is widened to carry post-collapse EMBEDDED children.
    if (config.type === AltVM.IsmType.ROUTING) {
      const rawWriter = this.artifactManager.createWriter(
        AltVM.IsmType.ROUTING,
        this.signer,
      );
      assert(
        rawWriter.composition === ArtifactComposition.ORCHESTRATED,
        `Routing ISM composition mismatch: '${config.composition}' config cannot be updated by a '${rawWriter.composition}' raw routing-ISM writer`,
      );
      assert(
        config.composition === ArtifactComposition.ORCHESTRATED,
        `Routing ISM composition mismatch: orchestrated writer cannot update an '${config.composition}' config`,
      );
      // CAST: `DeployedIsmArtifact` carries the pre-collapse
      // `IsmArtifactConfig`. The recursive `RoutingIsmWriter.update`
      // expects the post-collapse `ConfigOnChain<...>` shape. Runtime
      // values are already DEPLOYED/UNDERIVED (caller produced them via
      // a read), so this bridges TS's one-level mapped-type limitation.
      return this.routingWriter.update({
        artifactState,
        config: config as ConfigOnChain<
          WithCompositionVariant<
            RoutingIsmArtifactConfig,
            typeof ArtifactComposition.ORCHESTRATED
          >,
          DeployedIsmAddress
        >,
        deployed,
      });
    }

    // Multisig and test ISMs are immutable - no updates possible
    return [];
  }
}
