import {
  ArtifactState,
  type ArtifactDeployed,
  type ArtifactReader,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type RawIsmArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/ism';

import { StarknetProvider } from '../clients/provider.js';
import { getAggregationIsmConfig, getPausableIsmConfig } from './ism-query.js';

export class StarknetAggregationIsmReader implements ArtifactReader<
  RawIsmArtifactConfigs['staticAggregationIsm'],
  DeployedIsmAddress
> {
  constructor(private readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawIsmArtifactConfigs['staticAggregationIsm'],
      DeployedIsmAddress
    >
  > {
    const config = await getAggregationIsmConfig(
      this.provider.getRawProvider(),
      address,
    );
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'staticAggregationIsm',
        threshold: config.threshold,
        modules: config.modules.map((address) => ({
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address },
        })),
      },
      deployed: { address: config.address },
    };
  }
}

export class StarknetPausableIsmReader implements ArtifactReader<
  RawIsmArtifactConfigs['pausableIsm'],
  DeployedIsmAddress
> {
  constructor(private readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawIsmArtifactConfigs['pausableIsm'], DeployedIsmAddress>
  > {
    const config = await getPausableIsmConfig(
      this.provider.getRawProvider(),
      address,
    );
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'pausableIsm',
        owner: config.owner,
        paused: config.paused,
      },
      deployed: { address: config.address },
    };
  }
}
