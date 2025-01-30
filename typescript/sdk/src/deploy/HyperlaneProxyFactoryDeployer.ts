import { rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import { HyperlaneDeployer } from './HyperlaneDeployer.js';
import {
  ProxyFactoryFactories,
  proxyFactoryFactories,
  proxyFactoryImplementations,
} from './contracts.js';
import { ContractVerifier } from './verify/ContractVerifier.js';

export class HyperlaneProxyFactoryDeployer extends HyperlaneDeployer<
  {},
  ProxyFactoryFactories
> {
  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
    concurrentDeploy: boolean = false,
  ) {
    super(multiProvider, proxyFactoryFactories, {
      logger: rootLogger.child({ module: 'IsmFactoryDeployer' }),
      contractVerifier,
      concurrentDeploy,
    });
  }

  async deployContracts(
    chain: ChainName,
  ): Promise<HyperlaneContracts<ProxyFactoryFactories>> {
    const contracts: any = {};
    for (const factoryName of Object.keys(
      this.factories,
    ) as (keyof ProxyFactoryFactories)[]) {
      rootLogger.info(`Deploying ${factoryName} on ${chain}`);
      const factory = await this.deployContract(chain, factoryName, []);
      rootLogger.info(`Deployed ${factoryName} on ${chain}`);
      this.addVerificationArtifacts(chain, [
        {
          name: proxyFactoryImplementations[factoryName],
          address: await factory.implementation(),
          constructorArguments: '',
          isProxy: true,
        },
      ]);
      rootLogger.info(`Verified ${factoryName} on ${chain}`);
      contracts[factoryName] = factory;
      rootLogger.info(`Added ${factoryName} to contracts on ${chain}`);
    }
    return contracts as HyperlaneContracts<ProxyFactoryFactories>;
  }
}
