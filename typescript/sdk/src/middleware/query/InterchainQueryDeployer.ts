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

  async constructorArgs(_: string, __: RouterConfig): Promise<[]> {
    return [];
  }
  async initializeArgs(
    chain: string,
    config: RouterConfig,
  ): Promise<
    [
      _mailbox: string,
      _interchainGasPaymaster: string,
      _interchainSecurityModule: string,
      _owner: string,
    ]
  > {
    const owner = await this.multiProvider.getSignerAddress(chain);
    return [
      config.mailbox,
      config.interchainGasPaymaster,
      config.interchainSecurityModule ?? ethers.constants.AddressZero,
      owner,
    ];
  }
}
