import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

import { COMMON_CREATE2_FACTORY } from './constants';

export class Create2Deployer {
  multiProvider: MultiProvider;

  constructor(multiProvider: MultiProvider) {
    this.multiProvider = multiProvider;
  }

  async deployCreate2Factory(chain: ChainName): Promise<void> {
    const alreadyDeployed = await this.multiProvider.checkContractDeployed(
      chain,
      COMMON_CREATE2_FACTORY,
    );

    if (alreadyDeployed) {
      return;
    }
  }

  getDeploymentInfo(chain: ChainName): string {
    return `Create2Deployer: ${chain} ${COMMON_CREATE2_FACTORY}`;
  }
}
