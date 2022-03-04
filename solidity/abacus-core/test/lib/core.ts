import { ethers } from 'ethers';
import { utils, types } from '@abacus-network/utils';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

export class Validator {
  localDomain: types.Domain;
  signer: SignerWithAddress;
  address: types.Address;

  constructor(
    signer: SignerWithAddress,
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

  static fromSigner(signer: SignerWithAddress, localDomain: types.Domain) {
    return new Validator(signer, signer.address, localDomain, true);
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
    let message = this.message(root, index);
    let msgHash = ethers.utils.arrayify(ethers.utils.keccak256(message));
    let signature = await this.signer.signMessage(msgHash);
    return {
      origin: this.localDomain,
      root,
      index,
      signature,
    };
  }
}
