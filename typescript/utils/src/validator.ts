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
  merkle_tree_hook_address: Address;

  constructor(
    address: Address,
    localDomain: Domain,
    merkle_tree_hook_address: Address,
  ) {
    this.localDomain = localDomain;
    this.address = address;
    this.merkle_tree_hook_address = merkle_tree_hook_address;
  }

  domainHash() {
    return domainHash(this.localDomain, this.merkle_tree_hook_address);
  }

  message(checkpoint: Checkpoint, messageId: HexString) {
    const types = ['bytes32', 'bytes32', 'uint32', 'bytes32'];
    const values = [
      this.domainHash(),
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

export class Validator extends BaseValidator {
  constructor(
    protected signer: ethers.Signer,
    address: Address,
    localDomain: Domain,
    merkle_tree_hook_address: Address,
  ) {
    super(address, localDomain, merkle_tree_hook_address);
  }

  static async fromSigner(
    signer: ethers.Signer,
    localDomain: Domain,
    merkle_tree_hook_address: Address,
  ) {
    return new Validator(
      signer,
      await signer.getAddress(),
      localDomain,
      merkle_tree_hook_address,
    );
  }

  async signCheckpoint(
    root: HexString,
    index: number,
    messageId: string,
  ): Promise<S3Checkpoint> {
    const checkpoint = {
      root,
      index,
      merkle_tree_hook_address: this.merkle_tree_hook_address,
      mailbox_domain: this.localDomain,
    };
    const msgHash = this.messageHash(checkpoint, messageId);
    const signature = await this.signer.signMessage(msgHash);
    return {
      value: checkpoint,
      signature,
    };
  }
}
