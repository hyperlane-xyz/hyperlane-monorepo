import { objKeys } from '@hyperlane-xyz/utils';

import { appFromAddressesMapHelper } from '../contracts/contracts';
import { HyperlaneAddressesMap, HyperlaneContracts } from '../contracts/types';
import { MultiProvider } from '../providers/MultiProvider';
import { RouterApp } from '../router/RouterApps';

import { HypERC20Factories, hypERC20factories } from './contracts';

export class HypERC20App extends RouterApp<HypERC20Factories> {
  constructor(contractsMap: any, multiProvider: any) {
    super(contractsMap, multiProvider);
  }

  router(contracts: HyperlaneContracts<HypERC20Factories>): any {
    for (const key of objKeys(hypERC20factories)) {
      if (contracts[key]) {
        return contracts[key];
      }
    }
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
  ): HypERC20App {
    console.log(
      'HypERC20App.fromAddressesMap',
      JSON.stringify(addressesMap, null, 2),
    );
    const helper = appFromAddressesMapHelper(
      addressesMap,
      hypERC20factories,
      multiProvider,
    );
    return new HypERC20App(helper.contractsMap, helper.multiProvider);
  }
}
