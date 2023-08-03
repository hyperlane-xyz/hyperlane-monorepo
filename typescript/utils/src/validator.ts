import { ethers } from 'ethers';

import { domainHash } from './domains';
import {
  Address,
  Checkpoint,
  Domain,
  HexString,
  S3Checkpoint,
  SignatureLike,
} from './types';

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
    const types = ['bytes32', 'bytes32', 'uint32'];
    const values = [this.domainHash(), checkpoint.root, checkpoint.index];
    if (messageId) {
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

export class Validator extends BaseValidator {
  constructor(
    protected signer: ethers.Signer,
    address: Address,
    localDomain: Domain,
    mailbox: Address,
  ) {
    super(address, localDomain, mailbox);
  }

  static async fromSigner(
    signer: ethers.Signer,
    localDomain: Domain,
    mailbox: Address,
  ) {
    return new Validator(
      signer,
      await signer.getAddress(),
      localDomain,
      mailbox,
    );
  }

  async signCheckpoint(root: HexString, index: number): Promise<S3Checkpoint> {
    const checkpoint = {
      root,
      index,
      mailbox_address: this.mailbox,
      mailbox_domain: this.localDomain,
    };
    const msgHash = this.messageHash(checkpoint);
    const signature = await this.signer.signMessage(msgHash);
    return {
      value: checkpoint,
      signature,
    };
  }
}
