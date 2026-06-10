import {
  AltVM,
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactComposition,
  ArtifactDeployed,
  ConfigOnChain,
  WithCompositionVariant,
  isArtifactDeployed,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddress,
  DerivedIsmConfig,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
  ismArtifactToDerivedConfig,
  RawDeployedIsmArtifact,
  RawRoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { Logger, assert, rootLogger } from '@hyperlane-xyz/utils';

type OrchestratedIsmArtifactConfig = WithCompositionVariant<
  IsmArtifactConfig,
  typeof ArtifactComposition.ORCHESTRATED
>;

/**
 * Post-deploy on-chain shape: ORCHESTRATED ISM with composite children
 * collapsed via `ConfigOnChain`. Returned from `read()`.
 */
type OrchestratedDeployedIsmArtifact = ArtifactDeployed<
  ConfigOnChain<OrchestratedIsmArtifactConfig, DeployedIsmAddress>,
  DeployedIsmAddress
>;

/**
 * Factory function to create an IsmReader instance.
 * This helper centralizes the creation of artifact managers and ISM readers,
 * making it easier to instantiate readers across the codebase.
 *
 * @param chainMetadata Chain metadata for the target chain (protocol type is extracted from metadata.protocol)
 * @param chainLookup Chain lookup interface for resolving chain names and domain IDs
 * @returns An IsmReader instance
 *
 * @example
 * ```typescript
 * const reader = createIsmReader(chainMetadata, chainLookup);
 * const ismConfig = await reader.read(ismAddress);
 * ```
 */
export function createIsmReader(
  chainMetadata: ChainMetadataForAltVM,
  chainLookup: ChainLookup,
): IsmReader {
  const protocolProvider = getProtocolProvider(chainMetadata.protocol);
  const artifactManager: IRawIsmArtifactManager =
    protocolProvider.createIsmArtifactManager(chainMetadata);

  return new IsmReader(artifactManager, chainLookup);
}

/**
 * Generic ISM Reader that can read any ISM type by detecting its type
 * and recursively expanding nested ISMs (e.g., for routing ISMs).
 */
export class IsmReader {
  protected readonly logger: Logger = rootLogger.child({
    module: IsmReader.name,
  });

  constructor(
    protected readonly artifactManager: IRawIsmArtifactManager,
    protected readonly chainLookup: ChainLookup,
  ) {}

  async read(address: string): Promise<OrchestratedDeployedIsmArtifact> {
    // Read once via readIsm() - detects type
    const { artifactState, config, deployed } =
      await this.artifactManager.readIsm(address);

    // For routing ISMs, dispatch on composition. ORCHESTRATED expands
    // per-domain children recursively. EMBEDDED routing-ISM reads are not
    // exposed via this orchestrated reader — callers wanting embedded reads
    // should instantiate the raw routing-ISM reader directly (the post-deploy
    // shape is materially different and the orchestrated wrapper would lose
    // the embedded composition discriminant on the on-chain config).
    if (config.type === AltVM.IsmType.ROUTING) {
      const rawReader = this.artifactManager.createReader(
        AltVM.IsmType.ROUTING,
      );
      assert(
        rawReader.composition === ArtifactComposition.ORCHESTRATED,
        `Routing ISM composition mismatch at ${address}: orchestrated reader cannot expand a '${rawReader.composition}' raw routing-ISM reader; instantiate the raw routing-ISM reader directly`,
      );
      assert(
        config.composition === ArtifactComposition.ORCHESTRATED,
        `Routing ISM composition mismatch at ${address}: orchestrated reader cannot expand an on-chain '${config.composition}' config; instantiate the raw routing-ISM reader directly`,
      );
      return this.expandRoutingIsm({ artifactState, config, deployed });
    }

    // For non-routing ISMs, the raw and expanded configs are identical
    return {
      artifactState,
      config,
      deployed,
    };
  }

  /**
   * Expands a raw routing ISM config by recursively reading the domain ISMs.
   * Takes a pre-read raw artifact to avoid double reading.
   *
   * Returns the post-deploy on-chain shape — children collapse to
   * `ArtifactOnChain` via `ConfigOnChain`.
   */
  private async expandRoutingIsm(
    rawArtifact: ArtifactDeployed<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddress
    >,
  ): Promise<OrchestratedDeployedIsmArtifact> {
    const { artifactState, config, deployed } = rawArtifact;
    const domains: Record<number, RawDeployedIsmArtifact> = {};

    for (const [domainId, domainIsmConfig] of Object.entries(config.domains)) {
      if (!this.chainLookup.getChainName(parseInt(domainId))) {
        this.logger.warn(
          `Skipping derivation of unknown ${AltVM.IsmType.ROUTING} domain ${domainId}`,
        );
        continue;
      }

      let nestedIsm: RawDeployedIsmArtifact;
      if (isArtifactDeployed(domainIsmConfig)) {
        // Already a full deployed artifact, use as-is
        nestedIsm = domainIsmConfig;
      } else {
        // ArtifactUnderived - recursively read using self to get full config.
        // `this.read()` returns the post-collapse ORCHESTRATED narrowing of
        // DeployedIsmArtifact; the parent's `domains` slot is
        // `ArtifactOnChain<IsmArtifactConfig, D>` (pre-collapse child config).
        // Structurally the recursive result IS a subtype of
        // `RawDeployedIsmArtifact`; the wider pre-collapse alias unifies the
        // two branches above without an `as` cast.
        nestedIsm = await this.read(domainIsmConfig.deployed.address);
      }

      domains[parseInt(domainId)] = nestedIsm;
    }

    return {
      artifactState,
      config: {
        composition: ArtifactComposition.ORCHESTRATED,
        type: AltVM.IsmType.ROUTING,
        owner: config.owner,
        domains,
      },
      deployed,
    };
  }

  /**
   * Backward compatibility method that converts DeployedIsmArtifact to DerivedIsmConfig.
   * This allows IsmReader to be used as a drop-in replacement for the old AltVMIsmReader.
   */
  async deriveIsmConfig(address: string): Promise<DerivedIsmConfig> {
    const artifact = await this.read(address);
    return ismArtifactToDerivedConfig(artifact, this.chainLookup);
  }
}
