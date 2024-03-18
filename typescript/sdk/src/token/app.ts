import { appFromAddressesMapHelper } from '../contracts/contracts';
import { HyperlaneAddressesMap } from '../contracts/types';
import { MultiProvider } from '../providers/MultiProvider';
import { RouterApp } from '../router/RouterApps';

import { HypERC20Factories, hypERC20factories } from './contracts';

export class HypERC20App extends RouterApp<HypERC20Factories> {
  constructor(contractsMap: any, multiProvider: any) {
    super(contractsMap, multiProvider);
  }

  router(contracts: any): any {
    return contracts.hypERC20Router;
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
  ): HypERC20App {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      hypERC20factories,
      multiProvider,
    );
    return new HypERC20App(helper.contractsMap, helper.multiProvider);
  }
}
