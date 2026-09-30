import {
  ArtifactState,
  type ArtifactDeployed,
  type ArtifactReader,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  IsmType,
  type RawIsmArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/ism';
import { nonEmptyArray } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { getAggregationIsmConfig, getPausableIsmConfig } from './ism-query.js';

export class StarknetAggregationIsmReader implements ArtifactReader<
  RawIsmArtifactConfigs[typeof IsmType.AGGREGATION],
  DeployedIsmAddress
> {
  constructor(private readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawIsmArtifactConfigs[typeof IsmType.AGGREGATION],
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
        type: IsmType.AGGREGATION,
        threshold: config.threshold,
        modules: nonEmptyArray(
          config.modules.map((address) => ({
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address },
          })),
        ),
      },
      deployed: { address: config.address },
    };
  }
}

export class StarknetPausableIsmReader implements ArtifactReader<
  RawIsmArtifactConfigs[typeof IsmType.PAUSABLE],
  DeployedIsmAddress
> {
  constructor(private readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawIsmArtifactConfigs[typeof IsmType.PAUSABLE],
      DeployedIsmAddress
    >
  > {
    const config = await getPausableIsmConfig(
      this.provider.getRawProvider(),
      address,
    );
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.PAUSABLE,
        owner: config.owner,
        paused: config.paused,
      },
      deployed: { address: config.address },
    };
  }
}
