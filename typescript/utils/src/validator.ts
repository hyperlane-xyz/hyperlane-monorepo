import { ethers } from 'ethers';

import { types, utils } from '@abacus-network/utils';

import { Checkpoint } from './types';

export class BaseValidator {
  localDomain: types.Domain;
  address: types.Address;

  constructor(address: types.Address, localDomain: types.Domain) {
    this.localDomain = localDomain;
    this.address = address;
  }

  domainHash() {
    return utils.domainHash(this.localDomain);
  }

  message(root: types.HexString, index: number) {
    return ethers.utils.solidityPack(
      ['bytes32', 'bytes32', 'uint256'],
      [this.domainHash(), root, index],
    );
  }

  messageHash(root: types.HexString, index: number) {
    const message = this.message(root, index);
    return ethers.utils.arrayify(ethers.utils.keccak256(message));
  }

  recoverAddressFromCheckpoint(checkpoint: Checkpoint): types.Address {
    const msgHash = this.messageHash(checkpoint.root, checkpoint.index);
    return ethers.utils.recoverAddress(msgHash, checkpoint.signature);
  }

  matchesSigner(checkpoint: Checkpoint) {
    return this.recoverAddressFromCheckpoint(checkpoint) === this.address;
  }
}

export class Validator extends BaseValidator {
  constructor(
    protected signer: ethers.Signer,
    address: types.Address,
    localDomain: types.Domain,
  ) {
    super(address, localDomain);
  }

  static async fromSigner(signer: ethers.Signer, localDomain: types.Domain) {
    return new Validator(signer, await signer.getAddress(), localDomain);
  }

  async signCheckpoint(
    root: types.HexString,
    index: number,
  ): Promise<Checkpoint> {
    const msgHash = this.messageHash(root, index);
    const signature = await this.signer.signMessage(msgHash);
    return {
      root,
      index,
      signature,
    };
  }
}
