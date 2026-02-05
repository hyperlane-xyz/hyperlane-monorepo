import {
  type ArtifactDeployed,
  type ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedMailboxAddress,
  type MailboxOnChain,
} from '@hyperlane-xyz/provider-sdk/mailbox';

import {
  type CosmosMailboxQueryClient,
  getMailboxConfig,
} from './mailbox-query.js';

/**
 * Reader for Cosmos Mailbox.
 * Converts internal types to artifact API types.
 */
export class CosmosMailboxReader
  implements ArtifactReader<MailboxOnChain, DeployedMailboxAddress>
{
  constructor(protected readonly query: CosmosMailboxQueryClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>> {
    const mailboxConfig = await getMailboxConfig(this.query, address);

    const config: MailboxOnChain = {
      owner: mailboxConfig.owner,
      defaultIsm: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: {
          address: mailboxConfig.defaultIsm,
        },
      },
      defaultHook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: {
          address: mailboxConfig.defaultHook,
        },
      },
      requiredHook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: {
          address: mailboxConfig.requiredHook,
        },
      },
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: {
        address: mailboxConfig.address,
        domainId: mailboxConfig.localDomain,
      },
    };
  }
}
