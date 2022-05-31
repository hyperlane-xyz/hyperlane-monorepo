import { ethers } from 'ethers';

import { types, utils } from '@abacus-network/utils';

export class Validator {
  localDomain: types.Domain;
  signer: ethers.Signer;
  address: types.Address;

  constructor(
    signer: ethers.Signer,
    address: types.Address,
    localDomain: types.Domain,
    disableWarn: boolean,
  ) {
    if (!disableWarn) {
      throw new Error('Please use `Validator.fromSigner()` to instantiate.');
    }
    this.localDomain = localDomain ? localDomain : 0;
    this.signer = signer;
    this.address = address;
  }

  static async fromSigner(signer: ethers.Signer, localDomain: types.Domain) {
    return new Validator(signer, await signer.getAddress(), localDomain, true);
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

  async signCheckpoint(root: types.HexString, index: number) {
    const message = this.message(root, index);
    const msgHash = ethers.utils.arrayify(ethers.utils.keccak256(message));
    const signature = await this.signer.signMessage(msgHash);
    return {
      origin: this.localDomain,
      root,
      index,
      signature,
    };
  }
}
