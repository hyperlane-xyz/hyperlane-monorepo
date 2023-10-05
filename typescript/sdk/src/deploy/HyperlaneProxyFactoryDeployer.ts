import debug from 'debug';

import { HyperlaneContracts } from '../contracts/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

import { HyperlaneDeployer } from './HyperlaneDeployer';
import {
  ProxyFactoryFactories,
  proxyFactoryFactories,
  proxyFactoryImplementations,
} from './contracts';

export class HyperlaneProxyFactoryDeployer extends HyperlaneDeployer<
  any,
  ProxyFactoryFactories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, proxyFactoryFactories, {
      logger: debug('hyperlane:IsmFactoryDeployer'),
    });
  }

  async deployContracts(
    chain: ChainName,
  ): Promise<HyperlaneContracts<ProxyFactoryFactories>> {
    const contracts: any = {};
    for (const factoryName of Object.keys(
      this.factories,
    ) as (keyof ProxyFactoryFactories)[]) {
      const factory = await this.deployContract(chain, factoryName, []);
      this.verificationInputs[chain].push({
        name: proxyFactoryImplementations[factoryName],
        address: await factory.implementation(),
      });
      contracts[factoryName] = factory;
    }
    return contracts as HyperlaneContracts<ProxyFactoryFactories>;
  }
}
