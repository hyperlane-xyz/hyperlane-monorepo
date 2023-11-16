import { ethers } from 'ethers';

import { MultiProvider } from '../../providers/MultiProvider';
import { ProxiedRouterDeployer } from '../../router/ProxiedRouterDeployer';
import { RouterConfig } from '../../router/types';

import {
  InterchainQueryFactories,
  interchainQueryFactories,
} from './contracts';

export type InterchainQueryConfig = RouterConfig;

export class InterchainQueryDeployer extends ProxiedRouterDeployer<
  InterchainQueryConfig,
  InterchainQueryFactories,
  'interchainQueryRouter'
> {
  readonly routerContractName = 'interchainQueryRouter';

  constructor(multiProvider: MultiProvider) {
    super(multiProvider, interchainQueryFactories);
  }

  async constructorArgs(_: string, config: RouterConfig): Promise<[string]> {
    return [config.mailbox];
  }

  async initializeArgs(
    chain: string,
    config: RouterConfig,
  ): Promise<[string, string, string]> {
    const owner = await this.multiProvider.getSignerAddress(chain);
    if (typeof config.interchainSecurityModule === 'object') {
      throw new Error('ISM as object unimplemented');
    }
    return [
      config.hook ?? ethers.constants.AddressZero,
      config.interchainSecurityModule ?? ethers.constants.AddressZero,
      owner,
    ];
  }
}
