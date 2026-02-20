import {
  Hex,
  encodePacked,
  isHex,
  keccak256,
  recoverMessageAddress,
  serializeSignature,
  toBytes,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { eqAddress } from './addresses.js';
import { domainHash } from './domains.js';
import { fromHexString, toHexString } from './strings.js';
import {
  Address,
  Checkpoint,
  CheckpointWithId,
  HexString,
  ReorgEvent,
  S3CheckpointWithId,
  SignatureLike,
} from './types.js';

export interface ValidatorConfig {
  address: string;
  localDomain: number;
  mailbox: string;
}

/**
 * Utilities for validators to construct and verify checkpoints.
 */
export class BaseValidator {
  constructor(protected readonly config: ValidatorConfig) {}

  get address() {
    return this.config.address;
  }

  announceDomainHash() {
    return domainHash(this.config.localDomain, this.config.mailbox);
  }

  static checkpointDomainHash(
    localDomain: number,
    merkle_tree_address: Address,
  ) {
    return domainHash(localDomain, merkle_tree_address);
  }

  static message(checkpoint: Checkpoint, messageId: HexString) {
    const types = ['bytes32', 'bytes32', 'uint32', 'bytes32'];
    const values = [
      this.checkpointDomainHash(
        checkpoint.mailbox_domain,
        checkpoint.merkle_tree_hook_address,
      ),
      checkpoint.root,
      checkpoint.index,
      messageId,
    ];
    return encodePacked(types, values);
  }

  static messageHash(checkpoint: Checkpoint, messageId: HexString) {
    const message = this.message(checkpoint, messageId);
    return toBytes(keccak256(message));
  }

  static recoverAddressFromCheckpoint(
    checkpoint: Checkpoint,
    signature: SignatureLike,
    messageId: HexString,
  ): Promise<Address> {
    const msgHash = this.messageHash(checkpoint, messageId);
    const normalizedSignature =
      typeof signature === 'string'
        ? (signature as Hex)
        : serializeSignature({
            r: signature.r as Hex,
            s: signature.s as Hex,
            yParity: signature.v % 2 ? 1 : 0,
          });
    return recoverMessageAddress({
      message: { raw: toHex(msgHash) },
      signature: normalizedSignature,
    });
  }

  static recoverAddressFromCheckpointWithId(
    { checkpoint, message_id }: CheckpointWithId,
    signature: SignatureLike,
  ): Promise<Address> {
    return BaseValidator.recoverAddressFromCheckpoint(
      checkpoint,
      signature,
      message_id,
    );
  }

  static recoverAddress({
    value,
    signature,
  }: S3CheckpointWithId): Promise<Address> {
    return BaseValidator.recoverAddressFromCheckpointWithId(value, signature);
  }

  async matchesSigner(
    checkpoint: Checkpoint,
    signature: SignatureLike,
    messageId: HexString,
  ): Promise<boolean> {
    const address = await BaseValidator.recoverAddressFromCheckpoint(
      checkpoint,
      signature,
      messageId,
    );
    return eqAddress(address, this.config.address);
  }

  getLatestCheckpointIndex(): Promise<number> {
    throw new Error('Not implemented');
  }

  storageLocation(): string {
    throw new Error('Not implemented');
  }

  getLatestCheckpointUrl(): string {
    throw new Error('Not implemented');
  }

  getReorgStatus(): Promise<ReorgEvent | null> {
    throw new Error('Not implemented');
  }
}

/**
 * Create signature for validator announce
 */
export const createAnnounce = async (
  validatorPrivKey: string,
  storageLocation: string,
  mailboxAddress: string,
  localDomain: number,
) => {
  const domainIdBytes = Buffer.alloc(4);
  domainIdBytes.writeUInt32BE(localDomain);

  const domainHashBytes = toHexString(
    Buffer.concat([
      domainIdBytes,
      fromHexString(mailboxAddress),
      Buffer.from('HYPERLANE_ANNOUNCEMENT'),
    ]),
  );
  const domainHash = keccak256(domainHashBytes as Hex);

  const announcementDigestBytes = toHexString(
    Buffer.concat([fromHexString(domainHash), Buffer.from(storageLocation)]),
  );
  const announcementDigest = keccak256(announcementDigestBytes as Hex);

  if (!isHex(validatorPrivKey))
    throw new Error('Validator private key must be hex');
  const account = privateKeyToAccount(validatorPrivKey);
  return account.signMessage({ message: { raw: announcementDigest } });
};
