import { ethers } from 'ethers';

import { eqAddress } from './addresses.js';
import { domainHash } from './domains.js';
import { fromHexString, toHexString } from './strings.js';
import {
  Address,
  Checkpoint,
  CheckpointWithId,
  HexString,
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
    return ethers.utils.solidityPack(types, values);
  }

  static messageHash(checkpoint: Checkpoint, messageId: HexString) {
    const message = this.message(checkpoint, messageId);
    return ethers.utils.arrayify(ethers.utils.keccak256(message));
  }

  static recoverAddressFromCheckpoint(
    checkpoint: Checkpoint,
    signature: SignatureLike,
    messageId: HexString,
  ): Address {
    const msgHash = this.messageHash(checkpoint, messageId);
    return ethers.utils.verifyMessage(msgHash, signature);
  }

  static recoverAddressFromCheckpointWithId(
    { checkpoint, message_id }: CheckpointWithId,
    signature: SignatureLike,
  ): Address {
    return BaseValidator.recoverAddressFromCheckpoint(
      checkpoint,
      signature,
      message_id,
    );
  }

  static recoverAddress({ value, signature }: S3CheckpointWithId): Address {
    return BaseValidator.recoverAddressFromCheckpointWithId(value, signature);
  }

  matchesSigner(
    checkpoint: Checkpoint,
    signature: SignatureLike,
    messageId: HexString,
  ) {
    const address = BaseValidator.recoverAddressFromCheckpoint(
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
}

/**
 * Create signature for validator announce
 */
export const createAnnounce = async (
  validatorPrivKey: string,
  storageLocation: string,
  mailboxId: string,
  localDomain: number,
) => {
  const domainIdBytes = Buffer.alloc(4);
  domainIdBytes.writeUInt32BE(localDomain);

  const domainHashBytes = toHexString(
    Buffer.concat([
      domainIdBytes,
      fromHexString(mailboxId),
      Buffer.from('HYPERLANE_ANNOUNCEMENT'),
    ]),
  );
  const domainHash = ethers.utils.keccak256(domainHashBytes);

  const announcementDigestBytes = toHexString(
    Buffer.concat([fromHexString(domainHash), Buffer.from(storageLocation)]),
  );
  const announcementDigest = ethers.utils.keccak256(announcementDigestBytes);

  return new ethers.Wallet(validatorPrivKey).signMessage(
    fromHexString(announcementDigest),
  );
};
