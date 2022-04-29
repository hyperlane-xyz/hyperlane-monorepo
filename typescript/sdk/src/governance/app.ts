import { GovernanceRouter } from '@abacus-network/apps';
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import { GovernanceContracts } from '.';
import { Call } from '..';
import { AbacusApp } from '../app';
import { MultiProvider } from '../provider';
import { ChainMap, ChainName, ChainNameToDomainId } from '../types';
import { objMap, promiseObjAll } from '../utils';
import { GovernanceAddresses } from './contracts';
import { environments } from './environments';

type Environments = typeof environments;
type EnvironmentName = keyof Environments;

export class AbacusGovernance<
  Networks extends ChainName = ChainName,
> extends AbacusApp<GovernanceContracts, Networks> {
  constructor(
    networkAddresses: ChainMap<Networks, GovernanceAddresses>,
    multiProvider: MultiProvider<Networks>,
  ) {
    super(GovernanceContracts, networkAddresses, multiProvider);
  }

  static fromEnvironment(
    name: EnvironmentName,
    multiProvider: MultiProvider<keyof Environments[typeof name]>,
  ) {
    return new AbacusGovernance(environments[name], multiProvider);
  }

  pushCall(network: Networks, call: Call) {
    this.get(network).push(call);
  }

  getCalls(network: Networks) {
    return this.get(network).calls;
  }

  networkCalls = () =>
    Object.fromEntries(
      this.networks().map((network) => [network, this.getCalls(network)]),
    ) as ChainMap<Networks, Call[]>;

  routers = () => objMap(this.contractsMap, (_, d) => d.contracts.router);

  routerAddresses = () => objMap(this.routers(), (_, r) => r.address);

  governor = async (): Promise<{
    network: Networks;
    address: types.Address;
  }> => {
    for (const [network, router] of Object.entries<GovernanceRouter>(
      this.routers(),
    )) {
      const address = await router.governor();
      if (address !== ethers.constants.AddressZero) {
        return { network: network as Networks, address };
      }
    }
    throw new Error('No governor found');
  };

  build = async (): Promise<ethers.PopulatedTransaction[]> => {
    const governor = await this.governor();
    const governorRouter = this.routers()[governor.network];

    const networkTransactions = await promiseObjAll<
      Record<Networks, ethers.PopulatedTransaction>
    >(
      objMap(this.networkCalls(), (network, calls) => {
        if (network === governor.network) {
          return governorRouter.populateTransaction.call(calls);
        } else {
          return governorRouter.populateTransaction.callRemote(
            ChainNameToDomainId[network],
            calls,
          );
        }
      }),
    );
    return Object.values(networkTransactions);
  };

  execute = async (signer: ethers.Signer) => {
    const governor = await this.governor();

    const signerAddress = await signer.getAddress();
    if (signerAddress !== governor.address) {
      throw new Error(
        `Signer ${signerAddress} is not the governor ${governor.address}`,
      );
    }

    const transactions = await this.build();

    return Promise.all(
      transactions.map(async (tx) => {
        const response = await signer.sendTransaction(tx);
        return response.wait(5);
      }),
    );
  };

  estimateGas = async (
    provider: ethers.providers.Provider,
  ): Promise<ethers.BigNumber[]> => {
    const transactions = await this.build();
    const governor = await this.governor();
    return Promise.all(
      transactions.map(
        (tx) => provider.estimateGas({ ...tx, from: governor.address }), // Estimate gas as the governor
      ),
    );
  };
}
