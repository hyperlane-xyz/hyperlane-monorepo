import { ethers } from 'ethers';

import { domainHash } from './domains.js';
import {
  Address,
  Checkpoint,
  Domain,
  HexString,
  SignatureLike,
} from './types.js';

/**
 * Utilities for validators to construct and verify checkpoints.
 */
export class BaseValidator {
  constructor(
    public readonly address: Address,
    public readonly localDomain: Domain,
    public readonly mailbox_address: Address,
  ) {}

  announceDomainHash() {
    return domainHash(this.localDomain, this.mailbox_address);
  }

  checkpointDomainHash(merkle_tree_address: Address) {
    return domainHash(this.localDomain, merkle_tree_address);
  }

  message(checkpoint: Checkpoint, messageId: HexString) {
    const types = ['bytes32', 'bytes32', 'uint32', 'bytes32'];
    const values = [
      this.checkpointDomainHash(checkpoint.merkle_tree_hook_address),
      checkpoint.root,
      checkpoint.index,
      messageId,
    ];
    return ethers.utils.solidityPack(types, values);
  }

  messageHash(checkpoint: Checkpoint, messageId: HexString) {
    const message = this.message(checkpoint, messageId);
    return ethers.utils.arrayify(ethers.utils.keccak256(message));
  }

  recoverAddressFromCheckpoint(
    checkpoint: Checkpoint,
    signature: SignatureLike,
    messageId: HexString,
  ): Address {
    const msgHash = this.messageHash(checkpoint, messageId);
    return ethers.utils.verifyMessage(msgHash, signature);
  }

  matchesSigner(
    checkpoint: Checkpoint,
    signature: SignatureLike,
    messageId: HexString,
  ) {
    return (
      this.recoverAddressFromCheckpoint(
        checkpoint,
        signature,
        messageId,
      ).toLowerCase() === this.address.toLowerCase()
    );
  }
}
