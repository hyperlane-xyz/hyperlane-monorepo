import { joinSignature, splitSignature } from 'ethers/lib/utils.js';

import {
  Checkpoint,
  MerkleProof,
  SignatureLike,
  assert,
  chunk,
  ensure0x,
  fromHexString,
  strip0x,
  toHexString,
} from '@hyperlane-xyz/utils';

import { ModuleType } from '../types.js';

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

const SIGNATURE_LENGTH = 65;

export type MultisigMetadata =
  | MessageIdMultisigMetadata
  | MerkleRootMultisigMetadata;

export class MultisigMetadataBuilder {
  static encodeSimplePrefix(metadata: MessageIdMultisigMetadata): string {
    const checkpoint = metadata.checkpoint;
    const buf = Buffer.alloc(68);
    buf.write(strip0x(checkpoint.merkle_tree_hook_address), 0, 32, 'hex');
    buf.write(strip0x(checkpoint.root), 32, 32, 'hex');
    buf.writeUInt32BE(checkpoint.index, 64);
    return toHexString(buf);
  }

  static decodeSimplePrefix(metadata: string) {
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

  static encodeProofPrefix(metadata: MerkleRootMultisigMetadata): string {
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

  static decodeProofPrefix(metadata: string) {
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

  static signatureAt(
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
