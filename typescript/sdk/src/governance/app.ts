import { GovernanceContracts } from '.';
import { AbacusApp } from '../app';
import { objMap, promiseObjAll } from '../utils';
import { GovernanceNetworks } from './contracts';

export class GovernanceApp extends AbacusApp<
  GovernanceNetworks,
  GovernanceContracts
> {
  routers = () => objMap(this.domainMap, (d) => d.contracts.router);

  governors = () => promiseObjAll(objMap(this.domainMap, (d) => d.governor()));

  getCalls(network: GovernanceNetworks) {
    return this.get(network).calls;
  }
}
