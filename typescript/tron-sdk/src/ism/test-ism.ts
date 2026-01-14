import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { type TronIsmQueryClient, getNoopIsmConfig } from './ism-query.js';

/**
 * Reader for Tron NoopIsm (test ISM).
 * This is the simplest ISM type with no configuration beyond its address.
 */
export class TronTestIsmReader
  implements ArtifactReader<TestIsmConfig, DeployedIsmAddress>
{
  constructor(private readonly query: TronIsmQueryClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>> {
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
