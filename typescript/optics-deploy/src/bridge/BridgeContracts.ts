import * as xAppContracts from 'optics-ts-interface/dist/optics-xapps';
import { BridgeContractAddresses } from '../../src/config/addresses';
import { BeaconProxy } from '../proxyUtils';
import { Contracts } from '../contracts';
import * as ethers from 'ethers';

export class BridgeContracts extends Contracts {
  bridgeRouter?: BeaconProxy<xAppContracts.BridgeRouter>;
  bridgeToken?: BeaconProxy<xAppContracts.BridgeToken>;
  ethHelper?: xAppContracts.ETHHelper;

  constructor() {
    super();
  }

  toObject(): Object {
    return {
      bridgeRouter: this.bridgeRouter?.toObject(),
      bridgeToken: this.bridgeToken?.toObject(),
      ethHelper: this.ethHelper?.address,
    };
  }

  static fromAddresses(
    addresses: BridgeContractAddresses,
    provider: ethers.providers.JsonRpcProvider,
  ): BridgeContracts {
    const b = new BridgeContracts();
    b.bridgeRouter = BeaconProxy.fromAddresses(xAppContracts.BridgeRouter__factory, provider, addresses.bridgeRouter);
    b.bridgeToken = BeaconProxy.fromAddresses(xAppContracts.BridgeToken__factory, provider, addresses.bridgeToken);

    if (addresses.ethHelper) {
      b.ethHelper = xAppContracts.ETHHelper__factory.connect(
        addresses.ethHelper,
        provider,
      );
    }

    return b;
  }
}
