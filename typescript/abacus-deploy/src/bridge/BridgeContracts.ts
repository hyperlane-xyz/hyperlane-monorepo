import * as xAppContracts from '@abacus-network/ts-interface/dist/abacus-xapps';
import * as contracts from '@abacus-network/ts-interface/dist/abacus-core';
import { BridgeContractAddresses } from '../../src/config/addresses';
import { BeaconProxy } from '../utils/proxy';
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

    // TODO: needs type magic for turning governance, outbox and inboxs to BeaconProxy contracts
    const routerImplementation = xAppContracts.BridgeRouter__factory.connect(
      addresses.bridgeRouter.implementation,
      provider,
    );
    const routerProxy = xAppContracts.BridgeRouter__factory.connect(
      addresses.bridgeRouter.proxy,
      provider,
    );
    const routerUpgradeBeacon = contracts.UpgradeBeacon__factory.connect(
      addresses.bridgeRouter.beacon,
      provider,
    );
    b.bridgeRouter = new BeaconProxy<xAppContracts.BridgeRouter>(
      routerImplementation,
      routerProxy,
      routerUpgradeBeacon,
    );

    const tokenImplementation = xAppContracts.BridgeToken__factory.connect(
      addresses.bridgeToken.implementation,
      provider,
    );
    const tokenProxy = xAppContracts.BridgeToken__factory.connect(
      addresses.bridgeToken.proxy,
      provider,
    );
    const tokenUpgradeBeacon = contracts.UpgradeBeacon__factory.connect(
      addresses.bridgeToken.beacon,
      provider,
    );
    b.bridgeToken = new BeaconProxy<xAppContracts.BridgeToken>(
      tokenImplementation,
      tokenProxy,
      tokenUpgradeBeacon,
    );

    if (addresses.ethHelper) {
      b.ethHelper = xAppContracts.ETHHelper__factory.connect(
        addresses.ethHelper,
        provider,
      );
    }

    return b;
  }
}
