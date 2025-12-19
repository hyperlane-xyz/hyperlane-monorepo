import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddresses,
  TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { CosmosIsmQueryClient, getNoopIsmConfig } from './ism-query.js';

/**
 * Reader for Cosmos NoopIsm (test ISM).
 * This is the simplest ISM type with no configuration beyond its address.
 */
export class CosmosTestIsmReader
  implements ArtifactReader<TestIsmConfig, DeployedIsmAddresses>
{
  constructor(private readonly query: CosmosIsmQueryClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<TestIsmConfig, DeployedIsmAddresses>> {
    const ismConfig = await getNoopIsmConfig(this.query, address);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.TEST_ISM,
      },
      deployed: {
        address: ismConfig.address,
      },
    };
  }
}
