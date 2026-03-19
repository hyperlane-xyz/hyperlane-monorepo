import {
  AltVM,
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactReader,
  isArtifactDeployed,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddress,
  DeployedIsmArtifact,
  DerivedIsmConfig,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
  ismArtifactToDerivedConfig,
  RawRoutingIsmArtifactConfig,
  RoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { Logger, rootLogger } from '@hyperlane-xyz/utils';

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
export class IsmReader implements ArtifactReader<
  IsmArtifactConfig,
  DeployedIsmAddress
> {
  protected readonly logger: Logger = rootLogger.child({
    module: IsmReader.name,
  });

  constructor(
    protected readonly artifactManager: IRawIsmArtifactManager,
    protected readonly chainLookup: ChainLookup,
  ) {}

  async read(address: string): Promise<DeployedIsmArtifact> {
    // Read once via readIsm() - detects type
    const { artifactState, config, deployed } =
      await this.artifactManager.readIsm(address);

    // For routing ISMs, expand nested domain ISMs recursively
    if (config.type === AltVM.IsmType.ROUTING) {
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
   */
  private async expandRoutingIsm(
    rawArtifact: ArtifactDeployed<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddress
    >,
  ): Promise<ArtifactDeployed<RoutingIsmArtifactConfig, DeployedIsmAddress>> {
    const { artifactState, config, deployed } = rawArtifact;
    const domains: Record<number, DeployedIsmArtifact> = {};

    for (const [domainId, domainIsmConfig] of Object.entries(config.domains)) {
      if (!this.chainLookup.getChainName(parseInt(domainId))) {
        this.logger.warn(
          `Skipping derivation of unknown ${AltVM.IsmType.ROUTING} domain ${domainId}`,
        );
        continue;
      }

      let nestedIsm: DeployedIsmArtifact;
      if (isArtifactDeployed(domainIsmConfig)) {
        // Already a full deployed artifact, use as-is
        nestedIsm = domainIsmConfig;
      } else {
        // ArtifactUnderived - recursively read using self to get full config
        nestedIsm = await this.read(domainIsmConfig.deployed.address);
      }

      domains[parseInt(domainId)] = nestedIsm;
    }

    return {
      artifactState,
      config: {
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
