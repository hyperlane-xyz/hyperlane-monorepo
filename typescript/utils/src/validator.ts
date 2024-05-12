import { ethers } from 'ethers';

import { eqAddress } from './addresses.js';
import { domainHash } from './domains.js';
import { Address, Checkpoint, HexString, SignatureLike } from './types.js';

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

  announceDomainHash() {
    return domainHash(this.config.localDomain, this.config.mailbox);
  }

  checkpointDomainHash(merkle_tree_address: Address) {
    return domainHash(this.config.localDomain, merkle_tree_address);
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
    const address = this.recoverAddressFromCheckpoint(
      checkpoint,
      signature,
      messageId,
    );
    return eqAddress(address, this.config.address);
  }
}
