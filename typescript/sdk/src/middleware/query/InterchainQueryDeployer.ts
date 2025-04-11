import { ethers } from 'ethers';

import { Router } from '@hyperlane-xyz/core';

import { HyperlaneContracts } from '../../contracts/types.js';
import { ContractVerifier } from '../../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ProxiedRouterDeployer } from '../../router/ProxiedRouterDeployer.js';
import { MailboxAddress, RouterConfig } from '../../router/types.js';

import {
  InterchainQueryFactories,
  interchainQueryFactories,
} from './contracts.js';

export type InterchainQueryConfig = RouterConfig & MailboxAddress;

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
