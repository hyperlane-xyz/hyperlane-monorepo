import {
  AltVM,
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactReader,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddresses,
  DeployedIsmArtifact,
  DerivedIsmConfig,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
  IsmConfig,
  RawRoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { RoutingIsmReader } from './routing-ism.js';

/**
 * Factory function to create a GenericIsmReader instance.
 * This helper centralizes the creation of artifact managers and ISM readers,
 * making it easier to instantiate readers across the codebase.
 *
 * @param chainMetadata Chain metadata for the target chain (protocol type is extracted from metadata.protocol)
 * @param chainLookup Chain lookup interface for resolving chain names and domain IDs
 * @returns A GenericIsmReader instance
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
): GenericIsmReader {
  const protocolProvider = getProtocolProvider(chainMetadata.protocol);
  const artifactManager: IRawIsmArtifactManager =
    protocolProvider.createIsmArtifactManager(chainMetadata);

  return new GenericIsmReader(artifactManager, chainLookup);
}

/**
 * Converts a DeployedIsmArtifact to DerivedIsmConfig format.
 * This handles the conversion between the new Artifact API and the old Config API.
 */
function artifactToDerivedConfig(
  artifact: DeployedIsmArtifact,
): DerivedIsmConfig {
  const config = artifact.config as any;
  const address = artifact.deployed.address;

  // For routing ISMs, recursively convert nested artifacts
  if (config.type === AltVM.IsmType.ROUTING) {
    const domains: Record<string, IsmConfig | string> = {};
    for (const [domainId, nestedArtifact] of Object.entries(config.domains)) {
      if (typeof nestedArtifact === 'string') {
        domains[domainId] = nestedArtifact;
      } else {
        domains[domainId] = artifactToDerivedConfig(
          nestedArtifact as DeployedIsmArtifact,
        );
      }
    }
    return {
      type: 'domainRoutingIsm',
      owner: config.owner,
      domains,
      address,
    } as DerivedIsmConfig;
  }

  // For other ISM types, just add the address
  return {
    ...config,
    address,
  } as DerivedIsmConfig;
}

/**
 * Generic ISM Reader that can read any ISM type by detecting its type
 * and delegating to the appropriate reader. For routing ISMs, delegates
 * to RoutingIsmReader to handle recursive expansion of nested ISMs.
 */
export class GenericIsmReader
  implements ArtifactReader<IsmArtifactConfig, DeployedIsmAddresses>
{
  private readonly routingIsmReader: RoutingIsmReader;

  constructor(
    protected readonly artifactManager: IRawIsmArtifactManager,
    protected readonly chainLookup: ChainLookup,
  ) {
    // GenericIsmReader creates and owns RoutingIsmReader
    this.routingIsmReader = new RoutingIsmReader(
      chainLookup,
      artifactManager,
      this, // Pass self for recursion
    );
  }

  async read(address: string): Promise<DeployedIsmArtifact> {
    // Read once via readIsm() - detects type
    const rawArtifact = await this.artifactManager.readIsm(address);

    // For routing ISMs, delegate expansion (no re-reading)
    if (rawArtifact.config.type === AltVM.IsmType.ROUTING) {
      return this.routingIsmReader.expandFromRaw(
        rawArtifact as ArtifactDeployed<
          RawRoutingIsmArtifactConfig,
          DeployedIsmAddresses
        >,
      );
    }

    // For non-routing ISMs, the raw and expanded configs are identical
    return rawArtifact;
  }

  /**
   * Backward compatibility method that converts DeployedIsmArtifact to DerivedIsmConfig.
   * This allows GenericIsmReader to be used as a drop-in replacement for the old AltVMIsmReader.
   */
  async deriveIsmConfig(address: string): Promise<DerivedIsmConfig> {
    const artifact = await this.read(address);
    return artifactToDerivedConfig(artifact);
  }
}
