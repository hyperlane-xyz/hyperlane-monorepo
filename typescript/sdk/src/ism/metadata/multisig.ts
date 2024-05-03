import { defaultAbiCoder } from '@ethersproject/abi';
import { joinSignature } from 'ethers/lib/utils.js';

import { IValidatorAnnounce__factory } from '@hyperlane-xyz/core';
import {
  Checkpoint,
  MerkleProof,
  S3CheckpointWithId,
  SignatureLike,
  WithAddress,
  assert,
} from '@hyperlane-xyz/utils';

import '../../../../utils/dist/types.js';
import { S3Validator } from '../../aws/validator.js';
import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { DispatchedMessage } from '../../core/types.js';
import { ChainName } from '../../types.js';
import { IsmType, MultisigIsmConfig } from '../types.js';

import { MetadataBuilder } from './builder.js';

interface MessageIdMultisigMetadata {
  type: IsmType.MESSAGE_ID_MULTISIG;
  checkpoint: Omit<Checkpoint, 'mailbox_domain'>;
  signatures: SignatureLike[];
}

interface MerkleRootMultisigMetadata
  extends Omit<MessageIdMultisigMetadata, 'type'> {
  type: IsmType.MERKLE_ROOT_MULTISIG;
  proof: MerkleProof;
}

export type MultisigMetadata =
  | MessageIdMultisigMetadata
  | MerkleRootMultisigMetadata;

export class MultisigMetadataBuilder
  implements MetadataBuilder<WithAddress<MultisigIsmConfig>>
{
  constructor(protected readonly core: HyperlaneCore) {}

  async s3Validators(
    originChain: ChainName,
    validators: string[],
  ): Promise<S3Validator[]> {
    const originProvider = this.core.multiProvider.getProvider(origin);
    const validatorAnnounce = IValidatorAnnounce__factory.connect(
      this.core.getAddresses(originChain).validatorAnnounce,
      originProvider,
    );

    const storageLocations =
      await validatorAnnounce.getAnnouncedStorageLocations(validators);

    return Promise.all(
      storageLocations.map(([firstStorageLocation]) =>
        S3Validator.fromStorageLocation(firstStorageLocation),
      ),
    );
  }

  async build(
    message: DispatchedMessage,
    ismConfig: WithAddress<MultisigIsmConfig>,
  ): Promise<string> {
    assert(
      ismConfig.type === IsmType.MESSAGE_ID_MULTISIG,
      'Merkle proofs are not yet supported',
    );

    const originChain = this.core.multiProvider.getChainName(origin);
    const validators = await this.s3Validators(
      originChain,
      ismConfig.validators,
    );

    const matching = await Promise.race(
      validators.map((v) => v.findCheckpoint(message.id)),
    );
    const checkpoints = await Promise.all(
      validators.map((v) => v.getCheckpoint(matching.value.checkpoint.index)),
    );

    const metadata: MessageIdMultisigMetadata = {
      type: IsmType.MESSAGE_ID_MULTISIG,
      checkpoint: matching.value.checkpoint,
      signatures: checkpoints
        .filter((c): c is S3CheckpointWithId => c !== undefined)
        .map((c) => c.signature),
    };

    return MultisigMetadataBuilder.encode(metadata);
  }

  static encode(metadata: MultisigMetadata): string {
    assert(
      metadata.type === IsmType.MESSAGE_ID_MULTISIG,
      'Merkle proofs are not yet supported',
    );

    let encoded = defaultAbiCoder.encode(
      ['bytes32', 'bytes32', 'uint32'],
      [
        metadata.checkpoint.merkle_tree_hook_address,
        metadata.checkpoint.root,
        metadata.checkpoint.index,
      ],
    );

    metadata.signatures.forEach((signature) => {
      if (typeof signature !== 'string') {
        signature = joinSignature(signature);
      }
      encoded += signature;
    });

    return encoded;
  }

  static signatureAt(metadata: string, index: number): SignatureLike {
    const start = 68 + index * 65;
    const end = start + 65;
    return metadata.slice(start, end);
  }

  static hasSignature(metadata: string, index: number): boolean {
    try {
      this.signatureAt(metadata, index);
      return true;
    } catch (e) {
      return false;
    }
  }

  static decode(metadata: string): MessageIdMultisigMetadata {
    const checkpoint = {
      merkle_tree_hook_address: metadata.slice(0, 32),
      root: metadata.slice(32, 64),
      index: parseInt(metadata.slice(64, 68)),
    };

    const signatures: SignatureLike[] = [];
    for (let i = 0; this.hasSignature(metadata, i); i++) {
      signatures.push(this.signatureAt(metadata, i));
    }

    return { type: IsmType.MESSAGE_ID_MULTISIG, checkpoint, signatures };
  }
}
