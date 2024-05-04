import { TransactionReceipt } from '@ethersproject/providers';
import { joinSignature, splitSignature } from 'ethers/lib/utils.js';

import { MerkleTreeHook__factory } from '@hyperlane-xyz/core';
import type { InsertedIntoTreeEvent } from '@hyperlane-xyz/core/merkle';
import {
  Address,
  Checkpoint,
  MerkleProof,
  S3CheckpointWithId,
  SignatureLike,
  WithAddress,
  assert,
  chunk,
  ensure0x,
  eqAddress,
  eqAddressEvm,
  fromHexString,
  strip0x,
  toHexString,
} from '@hyperlane-xyz/utils';

import '../../../../utils/dist/types.js';
import { S3Validator } from '../../aws/validator.js';
import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { DispatchedMessage } from '../../core/types.js';
import { MerkleTreeHookConfig } from '../../hook/types.js';
import { ChainName, ChainNameOrId } from '../../types.js';
import { IsmType, ModuleType, MultisigIsmConfig } from '../types.js';

import { MetadataBuilder } from './builder.js';

interface MessageIdMultisigMetadata {
  type: ModuleType.MESSAGE_ID_MULTISIG;
  signatures: SignatureLike[];
  checkpoint: Omit<Checkpoint, 'mailbox_domain'>;
}

interface MerkleRootMultisigMetadata
  extends Omit<MessageIdMultisigMetadata, 'type'> {
  type: ModuleType.MERKLE_ROOT_MULTISIG;
  proof: MerkleProof;
}

const MerkleTreeInterface = MerkleTreeHook__factory.createInterface();

const SIGNATURE_LENGTH = 65;

export type MultisigMetadata =
  | MessageIdMultisigMetadata
  | MerkleRootMultisigMetadata;

export class MultisigMetadataBuilder
  implements
    MetadataBuilder<
      WithAddress<MultisigIsmConfig>,
      WithAddress<MerkleTreeHookConfig>
    >
{
  private validatorCache: Record<ChainName, Record<string, S3Validator>> = {};

  constructor(
    protected readonly core: HyperlaneCore,
    protected readonly logger = core.logger.child({
      module: 'MultisigMetadataBuilder',
    }),
  ) {}

  private async s3Validators(
    originChain: ChainName,
    validators: string[],
  ): Promise<S3Validator[]> {
    this.validatorCache[originChain] ??= {};
    const cached = new Set(Object.keys(this.validatorCache[originChain]));
    const toFetch = validators.filter((v) => !cached.has(v));

    const storageLocations = await this.core
      .getContracts(originChain)
      .validatorAnnounce.getAnnouncedStorageLocations(toFetch);

    const s3Validators = await Promise.all(
      storageLocations.map((locations) => {
        const latestLocation = locations.slice(-1)[0];
        return S3Validator.fromStorageLocation(latestLocation);
      }),
    );

    s3Validators.forEach((v) => {
      this.validatorCache[originChain][v.address] = v;
    });

    return validators.map((v) => this.validatorCache[originChain][v]);
  }

  private async getS3Checkpoints(
    validators: Address[],
    match: {
      origin: ChainNameOrId;
      merkleTree: Address;
      messageId: string;
      index: number;
    },
  ): Promise<S3CheckpointWithId[]> {
    const originChain = this.core.multiProvider.getChainName(origin);
    const s3Validators = await this.s3Validators(originChain, validators);

    const checkpointPromises = await Promise.allSettled(
      s3Validators.map((v) => v.getCheckpoint(match.index)),
    );
    const checkpoints = checkpointPromises
      .filter(
        (p): p is PromiseFulfilledResult<S3CheckpointWithId | undefined> =>
          p.status === 'fulfilled',
      )
      .map((p) => p.value)
      .filter((v): v is S3CheckpointWithId => v !== undefined);

    const matchingCheckpoints = checkpoints.filter(
      ({ value }) =>
        eqAddress(
          value.checkpoint.merkle_tree_hook_address,
          match.merkleTree,
        ) &&
        value.message_id === match.messageId &&
        value.checkpoint.index === match.index &&
        value.checkpoint.mailbox_domain === match.origin,
    );

    return matchingCheckpoints;
  }

  async build(
    message: DispatchedMessage,
    context: {
      ism: WithAddress<MultisigIsmConfig>;
      hook: WithAddress<MerkleTreeHookConfig>;
      dispatchTx: TransactionReceipt;
    },
  ): Promise<string> {
    assert(
      context.ism.type === IsmType.MESSAGE_ID_MULTISIG,
      'Merkle proofs are not yet supported',
    );

    const matchingInsertion = context.dispatchTx.logs
      .filter((l) => eqAddressEvm(l.address, context.hook.address))
      .map(
        (l) =>
          MerkleTreeInterface.parseLog(l) as unknown as InsertedIntoTreeEvent,
      )
      .find((e) => e.args.messageId === message.id);

    assert(
      matchingInsertion,
      `No merkle tree insertion of ${message.id} to ${context.hook.address} found in dispatch tx`,
    );

    const checkpoints = await this.getS3Checkpoints(context.ism.validators, {
      origin: message.parsed.origin,
      merkleTree: context.hook.address,
      messageId: message.id,
      index: matchingInsertion.args.index,
    });
    assert(
      checkpoints.length >= context.ism.threshold,
      `Only ${checkpoints.length} of ${context.ism.threshold} required signatures found`,
    );

    const signatures = checkpoints
      .map((c) => c.signature)
      .slice(0, context.ism.threshold);
    this.logger.debug(
      { signatures, message },
      `Taking ${signatures.length} (threshold) signatures for message ${message.id}`,
    );

    const metadata: MessageIdMultisigMetadata = {
      type: ModuleType.MESSAGE_ID_MULTISIG,
      checkpoint: checkpoints[0].value.checkpoint,
      signatures,
    };

    return MultisigMetadataBuilder.encode(metadata);
  }

  private static encodeSimplePrefix(
    metadata: MessageIdMultisigMetadata,
  ): string {
    const checkpoint = metadata.checkpoint;
    const buf = Buffer.alloc(68);
    buf.write(strip0x(checkpoint.merkle_tree_hook_address), 0, 32, 'hex');
    buf.write(strip0x(checkpoint.root), 32, 32, 'hex');
    buf.writeUInt32BE(checkpoint.index, 64);
    return toHexString(buf);
  }

  private static decodeSimplePrefix(metadata: string) {
    const buf = fromHexString(metadata);
    const merkleTree = toHexString(buf.subarray(0, 32));
    const root = toHexString(buf.subarray(32, 64));
    const index = buf.readUint32BE(64);
    const checkpoint = {
      root,
      index,
      merkle_tree_hook_address: merkleTree,
    };
    return {
      signatureOffset: 68,
      type: ModuleType.MESSAGE_ID_MULTISIG,
      checkpoint,
    };
  }

  private static encodeProofPrefix(
    metadata: MerkleRootMultisigMetadata,
  ): string {
    const checkpoint = metadata.checkpoint;
    const buf = Buffer.alloc(1096);
    buf.write(strip0x(checkpoint.merkle_tree_hook_address), 0, 32, 'hex');
    buf.writeUInt32BE(metadata.proof.index, 32);
    buf.write(strip0x(metadata.proof.leaf.toString()), 36, 32, 'hex');
    const branchEncoded = metadata.proof.branch
      .map((b) => strip0x(b.toString()))
      .join('');
    buf.write(branchEncoded, 68, 32 * 32, 'hex');
    buf.writeUint32BE(checkpoint.index, 1092);
    return toHexString(buf);
  }

  private static decodeProofPrefix(metadata: string) {
    const buf = fromHexString(metadata);
    const merkleTree = toHexString(buf.subarray(0, 32));
    const messageIndex = buf.readUint32BE(32);
    const signedMessageId = toHexString(buf.subarray(36, 68));
    const branchEncoded = buf.subarray(68, 1092).toString('hex');
    const branch = chunk(branchEncoded, 32 * 2).map((v) => ensure0x(v));
    const signedIndex = buf.readUint32BE(1092);
    const checkpoint = {
      root: '',
      index: messageIndex,
      merkle_tree_hook_address: merkleTree,
    };
    const proof: MerkleProof = {
      branch,
      leaf: signedMessageId,
      index: signedIndex,
    };
    return {
      signatureOffset: 1096,
      type: ModuleType.MERKLE_ROOT_MULTISIG,
      checkpoint,
      proof,
    };
  }

  static encode(metadata: MultisigMetadata): string {
    let encoded =
      metadata.type === ModuleType.MESSAGE_ID_MULTISIG
        ? this.encodeSimplePrefix(metadata)
        : this.encodeProofPrefix(metadata);

    metadata.signatures.forEach((signature) => {
      const encodedSignature = joinSignature(signature);
      assert(fromHexString(encodedSignature).byteLength === SIGNATURE_LENGTH);
      encoded += strip0x(encodedSignature);
    });

    return encoded;
  }

  private static signatureAt(
    metadata: string,
    offset: number,
    index: number,
  ): SignatureLike | undefined {
    const buf = fromHexString(metadata);
    const start = offset + index * SIGNATURE_LENGTH;
    const end = start + SIGNATURE_LENGTH;
    if (end > buf.byteLength) {
      return undefined;
    }

    return toHexString(buf.subarray(start, end));
  }

  static decode(
    metadata: string,
    type: ModuleType.MERKLE_ROOT_MULTISIG | ModuleType.MESSAGE_ID_MULTISIG,
  ): MultisigMetadata {
    const prefix: any =
      type === ModuleType.MERKLE_ROOT_MULTISIG
        ? this.decodeProofPrefix(metadata)
        : this.decodeSimplePrefix(metadata);

    const { signatureOffset: offset, ...values } = prefix;

    const signatures: SignatureLike[] = [];
    for (let i = 0; this.signatureAt(metadata, offset, i); i++) {
      const { r, s, v } = splitSignature(
        this.signatureAt(metadata, offset, i)!,
      );
      signatures.push({ r, s, v });
    }

    return {
      signatures,
      ...values,
    };
  }
}
