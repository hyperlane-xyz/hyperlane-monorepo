import { ethers } from 'ethers';

import { Address, Checkpoint, Domain, HexString } from './types';
import { domainHash } from './utils';

/**
 * Utilities for validators to construct and verify checkpoints.
 */
export class BaseValidator {
  localDomain: Domain;
  address: Address;

  constructor(address: Address, localDomain: Domain) {
    this.localDomain = localDomain;
    this.address = address;
  }

  domainHash() {
    return domainHash(this.localDomain);
  }

  message(root: HexString, index: number) {
    return ethers.utils.solidityPack(
      ['bytes32', 'bytes32', 'uint256'],
      [this.domainHash(), root, index],
    );
  }

  messageHash(root: HexString, index: number) {
    const message = this.message(root, index);
    return ethers.utils.arrayify(ethers.utils.keccak256(message));
  }

  recoverAddressFromCheckpoint(checkpoint: Checkpoint): Address {
    const msgHash = this.messageHash(checkpoint.root, checkpoint.index);
    return ethers.utils.verifyMessage(msgHash, checkpoint.signature);
  }

  matchesSigner(checkpoint: Checkpoint) {
    return (
      this.recoverAddressFromCheckpoint(checkpoint).toLowerCase() ===
      this.address.toLowerCase()
    );
  }
}

/**
 * Extension of BaseValidator that includes ethers signing utilities.
 */
export class Validator extends BaseValidator {
  constructor(
    protected signer: ethers.Signer,
    address: Address,
    localDomain: Domain,
  ) {
    super(address, localDomain);
  }

  static async fromSigner(signer: ethers.Signer, localDomain: Domain) {
    return new Validator(signer, await signer.getAddress(), localDomain);
  }

  async signCheckpoint(root: HexString, index: number): Promise<Checkpoint> {
    const msgHash = this.messageHash(root, index);
    const signature = await this.signer.signMessage(msgHash);
    return {
      root,
      index,
      signature,
    };
  }
}
