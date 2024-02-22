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
import { ContractVerifier } from './verify/ContractVerifier';

export class HyperlaneProxyFactoryDeployer extends HyperlaneDeployer<
  {},
  ProxyFactoryFactories
> {
  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
  ) {
    super(multiProvider, proxyFactoryFactories, {
      logger: debug('hyperlane:IsmFactoryDeployer'),
      contractVerifier,
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
      this.addVerificationArtifacts(chain, [
        {
          name: proxyFactoryImplementations[factoryName],
          address: await factory.implementation(),
          constructorArguments: '',
          isProxy: true,
        },
      ]);
      contracts[factoryName] = factory;
    }
    return contracts as HyperlaneContracts<ProxyFactoryFactories>;
  }
}
