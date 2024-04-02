import { ethers } from 'ethers';

import { ContractVerifier } from '../../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ProxiedRouterDeployer } from '../../router/ProxiedRouterDeployer.js';
import { RouterConfig } from '../../router/types.js';

import {
  InterchainQueryFactories,
  interchainQueryFactories,
} from './contracts.js';

export type InterchainQueryConfig = RouterConfig;

export class InterchainQueryDeployer extends ProxiedRouterDeployer<
  InterchainQueryConfig,
  InterchainQueryFactories,
  'interchainQueryRouter'
> {
  readonly routerContractName = 'interchainQueryRouter';

  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
  ) {
    super(multiProvider, interchainQueryFactories, {
      contractVerifier,
    });
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
