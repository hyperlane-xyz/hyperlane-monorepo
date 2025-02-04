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
    private factoryDeploymentPlan?: Record<string, boolean>,
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
      // Skip deployment if not in deployment plan
      if (
        this.factoryDeploymentPlan &&
        !this.factoryDeploymentPlan[factoryName]
      ) {
        this.logger.debug(
          `Skipping ${factoryName} deployment as it's not in deployment plan`,
        );
        continue;
      }

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
