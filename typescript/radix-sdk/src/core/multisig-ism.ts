import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  DerivedIsm,
  IsmArtifact,
  MultisigIsmConfig,
  RawIsmArtifactReader,
  RawIsmArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  ArtifactDeployed,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { getMultisigIsmConfig } from '../ism/ism-query.js';
import {
  getCreateMerkleRootMultisigIsmTx,
  getCreateMessageIdMultisigIsmTx,
} from '../ism/ism-tx.js';
import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';

export class MerkleRootMultisigIsmArtifactReader
  implements RawIsmArtifactReader<'merkleRootMultisigIsm'>
{
  constructor(private gateway: GatewayApiClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DerivedIsm>> {
    const multisigIsm = await getMultisigIsmConfig(this.gateway, address);

    return {
      artifactState: 'deployed',
      config: {
        type: 'merkleRootMultisigIsm',
        validators: multisigIsm.validators,
        threshold: multisigIsm.threshold,
      },
      deployed: {
        address,
      },
    };
  }
}

export class MerkleRootMultisigIsmArtifactWriter
  implements RawIsmArtifactWriter<'merkleRootMultisigIsm'>
{
  constructor(
    private account: string,
    private base: RadixBase,
    private signer: RadixBaseSigner,
  ) {}

  async create(
    artifact: IsmArtifact<'merkleRootMultisigIsm'>,
  ): Promise<[ArtifactDeployed<MultisigIsmConfig, DerivedIsm>, TxReceipt[]]> {
    const config = artifact.config;
    const manifest = await getCreateMerkleRootMultisigIsmTx(
      this.base,
      this.account,
      {
        validators: config.validators,
        threshold: config.threshold,
      },
    );

    const receipt = await this.signer.signAndBroadcast(manifest);
    const ismAddress = await this.base.getNewComponent(receipt);

    return [
      {
        artifactState: 'deployed',
        config,
        deployed: {
          address: ismAddress,
        },
      },
      [receipt],
    ];
  }

  async update(
    _address: string,
    _artifact: ArtifactDeployed<MultisigIsmConfig, DerivedIsm>,
  ): Promise<AnnotatedTx[]> {
    // Multisig ISMs are immutable - no updates possible
    return [];
  }
}

export class MessageIdMultisigIsmArtifactReader
  implements RawIsmArtifactReader<'messageIdMultisigIsm'>
{
  constructor(private gateway: GatewayApiClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DerivedIsm>> {
    const multisigIsm = await getMultisigIsmConfig(this.gateway, address);

    return {
      artifactState: 'deployed',
      config: {
        type: 'messageIdMultisigIsm',
        validators: multisigIsm.validators,
        threshold: multisigIsm.threshold,
      },
      deployed: {
        address,
      },
    };
  }
}

export class MessageIdMultisigIsmArtifactWriter
  implements RawIsmArtifactWriter<'messageIdMultisigIsm'>
{
  constructor(
    private account: string,
    private base: RadixBase,
    private signer: RadixBaseSigner,
  ) {}

  async create(
    artifact: IsmArtifact<'messageIdMultisigIsm'>,
  ): Promise<[ArtifactDeployed<MultisigIsmConfig, DerivedIsm>, TxReceipt[]]> {
    const config = artifact.config;
    const manifest = await getCreateMessageIdMultisigIsmTx(
      this.base,
      this.account,
      {
        validators: config.validators,
        threshold: config.threshold,
      },
    );

    const receipt = await this.signer.signAndBroadcast(manifest);
    const ismAddress = await this.base.getNewComponent(receipt);

    return [
      {
        artifactState: 'deployed',
        config,
        deployed: {
          address: ismAddress,
        },
      },
      [receipt],
    ];
  }

  async update(
    _address: string,
    _artifact: ArtifactDeployed<MultisigIsmConfig, DerivedIsm>,
  ): Promise<AnnotatedTx[]> {
    // Multisig ISMs are immutable - no updates possible
    return [];
  }
}
