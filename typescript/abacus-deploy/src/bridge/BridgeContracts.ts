import fs from 'fs';
import { xapps } from '@abacus-network/ts-interface';
import { ethers } from 'ethers';
import { CommonContracts, BeaconProxy } from '../common';
import { BridgeContractAddresses } from './types';

export class BridgeContracts extends CommonContracts<BridgeContractAddresses> {
  constructor(
    public readonly router: BeaconProxy<xapps.BridgeRouter>,
    public readonly token: BeaconProxy<xapps.BridgeToken>,
    public readonly helper?: xapps.ETHHelper,
  ) {
    super();
  }

  toObject(): BridgeContractAddresses {
    return {
      router: this.router.toObject(),
      token: this.token.toObject(),
      helper: this.helper?.address,
    };
  }

  // TODO(asa): Can this be added to Contracts instead?
  static readJson(filepath: string, signer: ethers.Signer): BridgeContracts {
    const contents = fs.readFileSync(filepath, 'utf8');
    const addresses: BridgeContractAddresses = JSON.parse(contents);
    return BridgeContracts.fromObject(addresses, signer);
  }

  static fromObject(
    addresses: BridgeContractAddresses,
    signer: ethers.Signer,
  ): BridgeContracts {
    const router: BeaconProxy<xapps.BridgeRouter> = BeaconProxy.fromObject(
      addresses.router,
      xapps.BridgeRouter__factory.abi,
      signer,
    );

    const token: BeaconProxy<xapps.BridgeToken> = BeaconProxy.fromObject(
      addresses.token,
      xapps.BridgeToken__factory.abi,
      signer,
    );

    if (addresses.helper) {
      const helper = xapps.ETHHelper__factory.connect(addresses.helper, signer);
      return new BridgeContracts(router, token, helper);
    }
    return new BridgeContracts(router, token);
  }
}
