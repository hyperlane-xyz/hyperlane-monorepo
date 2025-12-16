import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddresses,
  DeployedIsmArtifact,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
  RawRoutingIsmArtifactConfig,
  RoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { Logger, rootLogger } from '@hyperlane-xyz/utils';

/**
 * Generic ISM Reader that can read any ISM type by detecting its type
 * and delegating to the appropriate reader. Handles recursive reading
 * of nested ISM configurations (e.g., routing ISM domains).
 */
export class GenericIsmReader
  implements ArtifactReader<IsmArtifactConfig, DeployedIsmAddresses>
{
  protected readonly logger: Logger = rootLogger.child({
    module: GenericIsmReader.name,
  });

  constructor(
    protected readonly chainLookup: ChainLookup,
    protected readonly artifactManager: IRawIsmArtifactManager,
  ) {}

  async read(address: string): Promise<DeployedIsmArtifact> {
    // Use the artifact manager's readIsm to detect type and get raw config
    const rawArtifact = await this.artifactManager.readIsm(address);

    // For routing ISMs, recursively read the domain ISMs to get full configs
    if (rawArtifact.config.type === AltVM.IsmType.ROUTING) {
      return this.expandRoutingIsm(
        rawArtifact as ArtifactDeployed<
          RawRoutingIsmArtifactConfig,
          DeployedIsmAddresses
        >,
      );
    }

    // For non-routing ISMs, return as-is
    return rawArtifact;
  }

  /**
   * Expands a raw routing ISM config by recursively reading the domain ISMs.
   * Converts ArtifactOnChain (addresses) to full ArtifactDeployed configs.
   */
  private async expandRoutingIsm(
    rawArtifact: ArtifactDeployed<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddresses
    >,
  ): Promise<ArtifactDeployed<RoutingIsmArtifactConfig, DeployedIsmAddresses>> {
    const { config, deployed, artifactState } = rawArtifact;
    const domains: Record<number, DeployedIsmArtifact> = {};

    for (const [domainId, domainIsmConfig] of Object.entries(config.domains)) {
      if (!this.chainLookup.getDomainId(domainId)) {
        this.logger.warn(
          `Skipping derivation of unknown ${AltVM.IsmType.ROUTING} domain ${domainId}`,
        );
        continue;
      }

      let nestedIsm: DeployedIsmArtifact;
      if (domainIsmConfig.artifactState === ArtifactState.DEPLOYED) {
        // Already a full deployed artifact, use as-is
        nestedIsm = domainIsmConfig as DeployedIsmArtifact;
      } else {
        // ArtifactUnderived - recursively read to get full config
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
}
