import { RouterApp } from '../router/RouterApps';

export class HypERC20App extends RouterApp<any> {
  constructor(contractsMap: any, multiProvider: any) {
    super(contractsMap, multiProvider);
  }

  router(contracts: any): any {
    return contracts.hypERC20Router;
  }
}
