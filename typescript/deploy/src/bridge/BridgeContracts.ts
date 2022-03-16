import fs from 'fs';
import { ETHHelper, ETHHelper__factory, BridgeRouter, BridgeRouter__factory, BridgeToken, BridgeToken__factory} from '@abacus-network/apps';
import { ethers } from 'ethers';
import { CommonContracts, BeaconProxy } from '../common';
import { BridgeContractAddresses } from './types';

export class BridgeContracts extends CommonContracts<BridgeContractAddresses> {
  constructor(
    public readonly router: BeaconProxy<BridgeRouter>,
    public readonly token: BeaconProxy<BridgeToken>,
    public readonly helper?: ETHHelper,
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

  static readJson(filepath: string, signer: ethers.Signer): BridgeContracts {
    const contents = fs.readFileSync(filepath, 'utf8');
    const addresses: BridgeContractAddresses = JSON.parse(contents);
    return BridgeContracts.fromObject(addresses, signer);
  }

  static fromObject(
    addresses: BridgeContractAddresses,
    signer: ethers.Signer,
  ): BridgeContracts {
    const router: BeaconProxy<BridgeRouter> = BeaconProxy.fromObject(
      addresses.router,
      BridgeRouter__factory.abi,
      signer,
    );

    const token: BeaconProxy<BridgeToken> = BeaconProxy.fromObject(
      addresses.token,
      BridgeToken__factory.abi,
      signer,
    );

    if (addresses.helper) {
      const helper = ETHHelper__factory.connect(addresses.helper, signer);
      return new BridgeContracts(router, token, helper);
    }
    return new BridgeContracts(router, token);
  }
}
