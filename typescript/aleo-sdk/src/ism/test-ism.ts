import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddress,
  TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { AnyAleoNetworkClient } from '../clients/base.js';

import { getTestIsmConfig } from './ism-query.js';

export class AleoTestIsmReader
  implements ArtifactReader<TestIsmConfig, DeployedIsmAddress>
{
  constructor(private readonly aleoClient: AnyAleoNetworkClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>> {
    const ismConfig = await getTestIsmConfig(this.aleoClient, address);

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
