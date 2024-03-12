import { RouterApp } from '../router/RouterApps';

import { HypERC20Factories } from './contracts';

export class HypERC20App extends RouterApp<HypERC20Factories> {
  constructor(contractsMap: any, multiProvider: any) {
    super(contractsMap, multiProvider);
  }

  router(contracts: any): any {
    return contracts.hypERC20Router;
  }
}
