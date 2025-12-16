import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactReader,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddresses,
  DeployedIsmArtifact,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
  RawRoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { RoutingIsmReader } from './routing-ism.js';

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

    // For non-routing ISMs, return the raw config as-is
    return rawArtifact;
  }
}
