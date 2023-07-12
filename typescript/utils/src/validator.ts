import { ethers } from 'ethers';

import { Address, Checkpoint, Domain, HexString, SignatureLike } from './types';
import { domainHash } from './utils';

/**
 * Utilities for validators to construct and verify checkpoints.
 */
export class BaseValidator {
  localDomain: Domain;
  address: Address;
  mailbox: Address;

  constructor(address: Address, localDomain: Domain, mailbox: Address) {
    this.localDomain = localDomain;
    this.address = address;
    this.mailbox = mailbox;
  }

  domainHash() {
    return domainHash(this.localDomain, this.mailbox);
  }

  message(checkpoint: Checkpoint, messageId?: HexString) {
    let types = ['bytes32', 'bytes32', 'uint32'];
    let values = [this.domainHash(), checkpoint.root, checkpoint.index];
    if (!!messageId) {
      types.push('bytes32');
      values.push(messageId);
    }
    return ethers.utils.solidityPack(types, values);
  }

  messageHash(checkpoint: Checkpoint, messageId?: HexString) {
    const message = this.message(checkpoint, messageId);
    return ethers.utils.arrayify(ethers.utils.keccak256(message));
  }

  recoverAddressFromCheckpoint(
    checkpoint: Checkpoint,
    signature: SignatureLike,
    messageId?: HexString,
  ): Address {
    const msgHash = this.messageHash(checkpoint, messageId);
    return ethers.utils.verifyMessage(msgHash, signature);
  }

  matchesSigner(
    checkpoint: Checkpoint,
    signature: SignatureLike,
    messageId?: HexString,
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
