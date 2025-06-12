import { rootLogger } from '@hyperlane-xyz/utils';

import { attachContracts } from '../contracts/contracts.js';
import { HyperlaneContracts } from '../contracts/types.js';
import { isStaticDeploymentSupported } from '../ism/utils.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import { HyperlaneDeployer } from './HyperlaneDeployer.js';
import {
  ProxyFactoryFactories,
  proxyFactoryFactories,
  proxyFactoryImplementations,
} from './contracts.js';
import { createDefaultProxyFactoryFactories } from './proxyFactoryUtils.js';
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

    const technicalStack =
      this.multiProvider.getChainMetadata(chain).technicalStack;
    // Check if we should skip static address set deployment
    if (!isStaticDeploymentSupported(technicalStack)) {
      const addresses = createDefaultProxyFactoryFactories();
      return attachContracts(addresses, this.factories);
    }

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
