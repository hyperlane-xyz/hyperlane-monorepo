import { ControllerContracts } from '.';
import { Call } from '..';
import { ethers } from 'ethers';

import { types } from '@abacus-network/utils';

import { AbacusApp } from '../app';
import { MultiProvider } from '../provider';
import { ChainMap, ChainName, ChainNameToDomainId } from '../types';
import { objMap, promiseObjAll } from '../utils';

import { ControllerAddresses } from './contracts';
import { environments } from './environments';

type Environments = typeof environments;
type EnvironmentName = keyof Environments;

export type Controller = {
  domain: number;
  identifier: string;
};

export class ControllerApp<
  Networks extends ChainName = ChainName,
> extends AbacusApp<ControllerContracts, Networks> {
  constructor(
    networkAddresses: ChainMap<Networks, ControllerAddresses>,
    multiProvider: MultiProvider<Networks>,
  ) {
    super(ControllerContracts, networkAddresses, multiProvider);
  }

  static fromEnvironment(
    name: EnvironmentName,
    multiProvider: MultiProvider<any>,
  ) {
    return new ControllerApp(environments[name], multiProvider);
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

  controller = async (): Promise<{
    network: Networks;
    address: types.Address;
  }> => {
    const controllers = await promiseObjAll(
      objMap(this.routers(), (network, router) => router.controller()),
    );
    const match = Object.entries(controllers).find(
      ([_, controller]) => controller !== ethers.constants.AddressZero,
    ) as [Networks, types.Address] | undefined;
    if (match) {
      return { network: match[0], address: match[1] };
    }
    throw new Error('No controller found');
  };

  build = async (): Promise<ethers.PopulatedTransaction[]> => {
    const controller = await this.controller();
    const controllerRouter = this.routers()[controller.network];

    const networkTransactions = await promiseObjAll(
      objMap(this.networkCalls(), (network, calls) => {
        if (network === controller.network) {
          return controllerRouter.populateTransaction.call(calls);
        } else {
          return controllerRouter.populateTransaction.callRemote(
            ChainNameToDomainId[network],
            calls,
          );
        }
      }),
    );
    return Object.values(networkTransactions);
  };

  execute = async (signer: ethers.Signer) => {
    const controller = await this.controller();

    const signerAddress = await signer.getAddress();
    if (signerAddress !== controller.address) {
      throw new Error(
        `Signer ${signerAddress} is not the controller ${controller.address}`,
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
    const controller = await this.controller();
    return Promise.all(
      transactions.map(
        (tx) => provider.estimateGas({ ...tx, from: controller.address }), // Estimate gas as the controller
      ),
    );
  };
}
