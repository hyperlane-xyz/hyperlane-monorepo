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

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';

import { RadixCorePopulate } from './populate.js';
import { RadixCoreQuery } from './query.js';

export class MerkleRootMultisigIsmArtifactReader
  implements RawIsmArtifactReader<'merkleRootMultisigIsm'>
{
  constructor(private query: RadixCoreQuery) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DerivedIsm>> {
    const multisigIsm = await this.query.getMultisigIsm({ ism: address });

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
    private populate: RadixCorePopulate,
    private signer: RadixBaseSigner,
    private base: RadixBase,
  ) {}

  async create(
    artifact: IsmArtifact<'merkleRootMultisigIsm'>,
  ): Promise<[ArtifactDeployed<MultisigIsmConfig, DerivedIsm>, TxReceipt[]]> {
    const config = artifact.config;
    const manifest = await this.populate.createMerkleRootMultisigIsm({
      from_address: this.account,
      validators: config.validators,
      threshold: config.threshold,
    });

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
  constructor(private query: RadixCoreQuery) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DerivedIsm>> {
    const multisigIsm = await this.query.getMultisigIsm({ ism: address });

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
    private populate: RadixCorePopulate,
    private signer: RadixBaseSigner,
    private base: RadixBase,
  ) {}

  async create(
    artifact: IsmArtifact<'messageIdMultisigIsm'>,
  ): Promise<[ArtifactDeployed<MultisigIsmConfig, DerivedIsm>, TxReceipt[]]> {
    const config = artifact.config;
    const manifest = await this.populate.createMessageIdMultisigIsm({
      from_address: this.account,
      validators: config.validators,
      threshold: config.threshold,
    });

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
