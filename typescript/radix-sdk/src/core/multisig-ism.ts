import {
  IsmArtifact,
  MultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  ArtifactReader,
  ArtifactWriter,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';

import { RadixCorePopulate } from './populate.js';
import { RadixCoreQuery } from './query.js';

export class MerkleRootMultisigIsmArtifactReader
  implements ArtifactReader<IsmArtifact<'merkleRootMultisigIsm'>>
{
  constructor(private query: RadixCoreQuery) {}

  async read(address: string): Promise<MultisigIsmConfig> {
    const multisigIsm = await this.query.getMultisigIsm({ ism: address });

    return {
      type: 'merkleRootMultisigIsm',
      validators: multisigIsm.validators,
      threshold: multisigIsm.threshold,
    };
  }
}

export class MerkleRootMultisigIsmArtifactWriter
  implements ArtifactWriter<IsmArtifact<'merkleRootMultisigIsm'>>
{
  constructor(
    private account: string,
    private populate: RadixCorePopulate,
    private signer: RadixBaseSigner,
    private base: RadixBase,
  ) {}

  async create(
    config: MultisigIsmConfig,
  ): Promise<[{ deployedIsm: string }, TxReceipt[]]> {
    const manifest = await this.populate.createMerkleRootMultisigIsm({
      from_address: this.account,
      validators: config.validators,
      threshold: config.threshold,
    });

    const receipt = await this.signer.signAndBroadcast(manifest);
    const ismAddress = await this.base.getNewComponent(receipt);

    return [{ deployedIsm: ismAddress }, [receipt]];
  }

  async update(
    _address: string,
    _config: MultisigIsmConfig,
  ): Promise<AnnotatedTx[]> {
    // Multisig ISMs are immutable - no updates possible
    return [];
  }
}

export class MessageIdMultisigIsmArtifactReader
  implements ArtifactReader<IsmArtifact<'messageIdMultisigIsm'>>
{
  constructor(private query: RadixCoreQuery) {}

  async read(address: string): Promise<MultisigIsmConfig> {
    const multisigIsm = await this.query.getMultisigIsm({ ism: address });

    return {
      type: 'messageIdMultisigIsm',
      validators: multisigIsm.validators,
      threshold: multisigIsm.threshold,
    };
  }
}

export class MessageIdMultisigIsmArtifactWriter
  implements ArtifactWriter<IsmArtifact<'messageIdMultisigIsm'>>
{
  constructor(
    private account: string,
    private populate: RadixCorePopulate,
    private signer: RadixBaseSigner,
    private base: RadixBase,
  ) {}

  async create(
    config: MultisigIsmConfig,
  ): Promise<[{ deployedIsm: string }, TxReceipt[]]> {
    const manifest = await this.populate.createMessageIdMultisigIsm({
      from_address: this.account,
      validators: config.validators,
      threshold: config.threshold,
    });

    const receipt = await this.signer.signAndBroadcast(manifest);
    const ismAddress = await this.base.getNewComponent(receipt);

    return [{ deployedIsm: ismAddress }, [receipt]];
  }

  async update(
    _address: string,
    _config: MultisigIsmConfig,
  ): Promise<AnnotatedTx[]> {
    // Multisig ISMs are immutable - no updates possible
    return [];
  }
}
