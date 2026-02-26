import {
  AltVM,
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactReader,
  isArtifactDeployed,
  isArtifactUnderived,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddress,
  DeployedIsmArtifact,
  DerivedIsmConfig,
  DomainRoutingIsmConfig,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
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
 * Converts a DeployedIsmArtifact to DerivedIsmConfig format.
 * This handles the conversion between the new Artifact API and the old Config API.
 */
function artifactToDerivedConfig(
  artifact: DeployedIsmArtifact,
  chainLookup: ChainLookup,
): DerivedIsmConfig {
  const config = artifact.config;
  const address = artifact.deployed.address;

  // For routing ISMs, recursively convert nested artifacts
  if (config.type === AltVM.IsmType.ROUTING) {
    const domains: DomainRoutingIsmConfig['domains'] = {};
    for (const [domainId, nestedArtifact] of Object.entries(config.domains)) {
      // Convert numeric domain ID to chain name for the config output
      const chainName = chainLookup.getChainName(parseInt(domainId));
      if (!chainName) {
        // Skip unknown domains (already warned during expand)
        continue;
      }

      if (isArtifactUnderived(nestedArtifact)) {
        domains[chainName] = nestedArtifact.deployed.address;
      } else if (isArtifactDeployed(nestedArtifact)) {
        domains[chainName] = artifactToDerivedConfig(
          nestedArtifact,
          chainLookup,
        );
      }
      // Note: ArtifactState.NEW should never occur in expanded routing configs
    }
    return {
      type: 'domainRoutingIsm',
      owner: config.owner,
      domains,
      address,
    } satisfies Extract<DerivedIsmConfig, DomainRoutingIsmConfig>;
  }

  // For other ISM types, just add the address
  return {
    ...config,
    address,
  };
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
    return artifactToDerivedConfig(artifact, this.chainLookup);
  }
}
