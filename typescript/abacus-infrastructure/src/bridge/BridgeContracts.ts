import fs from 'fs';
import { xapps } from '@abacus-network/ts-interface';
import { ethers } from 'ethers';
import { Contracts, BeaconProxy } from '@abacus-network/abacus-deploy';
import { BridgeContractAddresses } from './types';

export class BridgeContracts extends Contracts<BridgeContractAddresses> {
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
  static readJson(
    filepath: string,
    provider: ethers.providers.JsonRpcProvider,
  ): BridgeContracts {
    const contents = fs.readFileSync(filepath, 'utf8');
    const addresses: BridgeContractAddresses = JSON.parse(contents);
    return BridgeContracts.fromObject(addresses, provider);
  }

  static fromObject(
    addresses: BridgeContractAddresses,
    provider: ethers.providers.JsonRpcProvider,
  ): BridgeContracts {
    const router: BeaconProxy<xapps.BridgeRouter> = BeaconProxy.fromObject(
      addresses.router,
      xapps.BridgeRouter__factory.abi,
      provider,
    );

    const token: BeaconProxy<xapps.BridgeToken> = BeaconProxy.fromObject(
      addresses.token,
      xapps.BridgeToken__factory.abi,
      provider,
    );

    if (addresses.helper) {
      const helper = xapps.ETHHelper__factory.connect(
        addresses.helper,
        provider,
      );
      return new BridgeContracts(router, token, helper);
    }
    return new BridgeContracts(router, token);
  }
}
