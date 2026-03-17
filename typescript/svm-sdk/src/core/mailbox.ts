import {
  address as parseAddress,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

import {
  type ArtifactDeployed,
  type ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedMailboxAddress,
  MailboxOnChain,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import { ZERO_ADDRESS_HEX_32, assert } from '@hyperlane-xyz/utils';

import {
  fetchMailboxInboxAccount,
  fetchMailboxOutboxAccount,
} from './mailbox-query.js';

export class SvmMailboxReader implements ArtifactReader<
  MailboxOnChain,
  DeployedMailboxAddress
> {
  constructor(protected readonly rpc: Rpc<SolanaRpcApi>) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>> {
    const programId = parseAddress(address);

    const inbox = await fetchMailboxInboxAccount(this.rpc, programId);
    assert(inbox, `Mailbox inbox not initialized at ${programId}`);

    const outbox = await fetchMailboxOutboxAccount(this.rpc, programId);
    assert(outbox, `Mailbox outbox not initialized at ${programId}`);

    // On SVM the mailbox IS the merkle tree hook — return the mailbox
    // address for both defaultHook and requiredHook as UNDERIVED artifacts.
    const mailboxHookRef = {
      artifactState: ArtifactState.UNDERIVED,
      deployed: { address: programId },
    };

    const config: MailboxOnChain = {
      owner: outbox.owner ?? ZERO_ADDRESS_HEX_32,
      defaultIsm: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: inbox.defaultIsm },
      },
      defaultHook: mailboxHookRef,
      requiredHook: mailboxHookRef,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: {
        address: programId,
        domainId: inbox.localDomain,
      },
    };
  }
}
