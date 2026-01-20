import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedMailboxAddress,
  RawMailboxConfig,
} from '@hyperlane-xyz/provider-sdk/mailbox';

import { getMailboxConfig } from './mailbox-query.js';

export class RadixMailboxReader
  implements ArtifactReader<RawMailboxConfig, DeployedMailboxAddress>
{
  constructor(protected readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<RawMailboxConfig, DeployedMailboxAddress>> {
    const mailboxConfig = await getMailboxConfig(this.gateway, address);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        owner: mailboxConfig.owner,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: mailboxConfig.defaultIsm },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: mailboxConfig.defaultHook },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: mailboxConfig.requiredHook },
        },
      },
      deployed: {
        address: mailboxConfig.address,
        domainId: mailboxConfig.localDomain,
      },
    };
  }
}
