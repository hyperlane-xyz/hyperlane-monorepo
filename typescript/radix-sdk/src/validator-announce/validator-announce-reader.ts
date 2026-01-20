import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedValidatorAnnounceAddress,
  RawValidatorAnnounceConfig,
} from '@hyperlane-xyz/provider-sdk/validator-announce';

import { getValidatorAnnounceConfig } from './validator-announce.js';

export class RadixValidatorAnnounceReader
  implements
    ArtifactReader<RawValidatorAnnounceConfig, DeployedValidatorAnnounceAddress>
{
  constructor(protected readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawValidatorAnnounceConfig,
      DeployedValidatorAnnounceAddress
    >
  > {
    const validatorAnnounceConfig = await getValidatorAnnounceConfig(
      this.gateway,
      address,
    );

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        mailboxAddress: validatorAnnounceConfig.mailboxAddress,
      },
      deployed: {
        address: validatorAnnounceConfig.address,
      },
    };
  }
}
