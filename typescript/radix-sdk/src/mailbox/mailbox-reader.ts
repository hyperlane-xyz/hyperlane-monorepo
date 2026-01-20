import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedMailboxAddress,
  MailboxOnChain,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import { ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';

import { getMailboxConfig } from './mailbox-query.js';

export class RadixMailboxReader
  implements ArtifactReader<MailboxOnChain, DeployedMailboxAddress>
{
  constructor(protected readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>> {
    const mailboxConfig = await getMailboxConfig(this.gateway, address);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        owner: mailboxConfig.owner,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: mailboxConfig.defaultIsm || ZERO_ADDRESS_HEX_32,
          },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: mailboxConfig.defaultHook || ZERO_ADDRESS_HEX_32,
          },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: mailboxConfig.requiredHook || ZERO_ADDRESS_HEX_32,
          },
        },
      },
      deployed: {
        address: mailboxConfig.address,
        domainId: mailboxConfig.localDomain,
      },
    };
  }
}
