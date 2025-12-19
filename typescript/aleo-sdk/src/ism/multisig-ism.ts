import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddresses,
  MultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { AnyAleoNetworkClient } from '../clients/base.js';

import { getMessageIdMultisigIsmConfig } from './ism-query.js';

export class AleoMessageIdMultisigIsmReader
  implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddresses>
{
  constructor(private readonly aleoClient: AnyAleoNetworkClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddresses>> {
    const ismConfig = await getMessageIdMultisigIsmConfig(
      this.aleoClient,
      address,
    );

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: ismConfig.validators,
        threshold: ismConfig.threshold,
      },
      deployed: {
        address: ismConfig.address,
      },
    };
  }
}
