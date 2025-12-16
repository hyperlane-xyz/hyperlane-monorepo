import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactReader,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddresses,
  DeployedIsmArtifact,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
  RawRoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { RoutingIsmReader } from './routing-ism.js';

export class GenericIsmReader
  implements ArtifactReader<IsmArtifactConfig, DeployedIsmAddresses>
{
  constructor(
    private readonly artifactManager: IRawIsmArtifactManager,
    private readonly routingIsmReader: RoutingIsmReader,
  ) {}

  async read(address: string): Promise<DeployedIsmArtifact> {
    const reader = this.artifactManager.createReader('genericIsm');
    const artifact = await reader.read(address);

    if (artifact.config.type === AltVM.IsmType.ROUTING) {
      return this.routingIsmReader.readNested(
        artifact as ArtifactDeployed<
          RawRoutingIsmArtifactConfig,
          DeployedIsmAddresses
        >,
      );
    }

    return artifact as DeployedIsmArtifact;
  }
}
