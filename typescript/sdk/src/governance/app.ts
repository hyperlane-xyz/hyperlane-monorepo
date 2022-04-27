import { GovernanceContracts } from '.';
import { AbacusApp } from '../app';
import { MultiProvider } from '../provider';
import { ChainName, ChainSubsetMap } from '../types';
import { objMap, promiseObjAll } from '../utils';
import { GovernanceAddresses } from './contracts';
import { environments } from './environments';

type Environments = typeof environments;
type EnvironmentName = keyof Environments;

export class AbacusGovernance<
  Networks extends ChainName = ChainName,
> extends AbacusApp<GovernanceContracts, Networks> {
  constructor(
    networkAddresses: ChainSubsetMap<Networks, GovernanceAddresses>,
    multiProvider: MultiProvider<Networks>,
  ) {
    super(
      objMap<Networks, any, any>(
        networkAddresses,
        (local, addresses) =>
          new GovernanceContracts(
            addresses,
            multiProvider.getDomainConnection(local).getConnection()!,
          ),
      ),
    );
  }

  static fromEnvironment(
    name: EnvironmentName,
    multiProvider: MultiProvider<keyof Environments[typeof name]>,
  ) {
    return new AbacusGovernance(environments[name], multiProvider);
  }

  routers = () => objMap(this.domainMap, (_, d) => d.contracts.router);

  routerAddresses = () => objMap(this.routers(), (_, r) => r.address);

  governors = () =>
    promiseObjAll<Record<Networks, string>>(
      objMap(this.domainMap, (_, d) => d.governor()),
    );

  getCalls(network: Networks) {
    return this.get(network).calls;
  }
}
