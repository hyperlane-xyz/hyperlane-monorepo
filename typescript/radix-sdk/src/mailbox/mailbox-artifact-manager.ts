import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedMailboxAddress,
  IRawMailboxArtifactManager,
  MailboxType,
  RawMailboxArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/mailbox';

import { RadixSigner } from '../clients/signer.js';
import { RadixBase } from '../utils/base.js';

import { RadixMailboxReader } from './mailbox-reader.js';
import { RadixMailboxWriter } from './mailbox-writer.js';

export class RadixMailboxArtifactManager implements IRawMailboxArtifactManager {
  constructor(
    private readonly gateway: GatewayApiClient,
    private readonly base: RadixBase,
    private readonly domainId: number,
  ) {}

  async readMailbox(address: string) {
    const reader = this.createReader('mailbox');
    return reader.read(address);
  }

  createReader<T extends MailboxType>(
    _type: T,
  ): ArtifactReader<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    return new RadixMailboxReader(this.gateway) as ArtifactReader<
      RawMailboxArtifactConfigs[T],
      DeployedMailboxAddress
    >;
  }

  createWriter<T extends MailboxType>(
    _type: T,
    signer: RadixSigner,
  ): ArtifactWriter<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    const baseSigner = signer.getBaseSigner();

    return new RadixMailboxWriter(
      this.gateway,
      baseSigner,
      this.base,
      this.domainId,
    ) as ArtifactWriter<RawMailboxArtifactConfigs[T], DeployedMailboxAddress>;
  }
}
