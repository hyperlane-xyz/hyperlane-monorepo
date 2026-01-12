import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
  ArtifactUnderived,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddress,
  RawRoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { AnyAleoNetworkClient } from '../clients/base.js';

import { getRoutingIsmConfig } from './ism-query.js';

export class AleoRoutingIsmRawReader
  implements ArtifactReader<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
{
  constructor(protected readonly aleoClient: AnyAleoNetworkClient) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
  > {
    const ismConfig = await getRoutingIsmConfig(this.aleoClient, address);

    const domains: Record<number, ArtifactUnderived<DeployedIsmAddress>> = {};
    for (const route of ismConfig.routes) {
      domains[route.domainId] = {
        deployed: {
          address: route.ismAddress,
        },
        artifactState: ArtifactState.UNDERIVED,
      };
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.ROUTING,
        owner: ismConfig.owner,
        domains,
      },
      deployed: {
        address: ismConfig.address,
      },
    };
  }
}
