import { ethers } from 'ethers';

import { type Router } from '@hyperlane-xyz/core';

import { type HyperlaneContracts } from '../../contracts/types.js';
import { type ContractVerifier } from '../../deploy/verify/ContractVerifier.js';
import { type MultiProvider } from '../../providers/MultiProvider.js';
import { ProxiedRouterDeployer } from '../../router/ProxiedRouterDeployer.js';
import { type RouterConfig } from '../../router/types.js';

import {
  type InterchainQueryFactories,
  interchainQueryFactories,
} from './contracts.js';

export type InterchainQueryConfig = RouterConfig;

export class InterchainQueryDeployer extends ProxiedRouterDeployer<
  InterchainQueryConfig,
  InterchainQueryFactories
> {
  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
    concurrentDeploy = false,
  ) {
    super(multiProvider, interchainQueryFactories, {
      contractVerifier,
      concurrentDeploy,
    });
  }

  routerContractName(): string {
    return 'InterchainQueryRouter';
  }

  routerContractKey<K extends keyof InterchainQueryFactories>(): K {
    return 'interchainQueryRouter' as K;
  }

  router(contracts: HyperlaneContracts<InterchainQueryFactories>): Router {
    return contracts.interchainQueryRouter;
  }

  async constructorArgs<K extends keyof InterchainQueryFactories>(
    _: string,
    config: RouterConfig,
  ): Promise<Parameters<InterchainQueryFactories[K]['deploy']>> {
    return [config.mailbox] as any;
  }

  async initializeArgs(chain: string, config: RouterConfig): Promise<any> {
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
