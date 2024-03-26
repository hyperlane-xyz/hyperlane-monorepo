import { ethers } from 'ethers';

import { Router } from '@hyperlane-xyz/core';
import { objKeys } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../../contracts/types';
import { ContractVerifier } from '../../deploy/verify/ContractVerifier';
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
  InterchainQueryFactories
> {
  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
  ) {
    super(multiProvider, interchainQueryFactories, {
      contractVerifier,
    });
  }

  routerContractName<K extends keyof InterchainQueryFactories>(
    _: RouterConfig,
  ): K {
    return 'interchainQueryRouter' as K;
  }

  router(contracts: HyperlaneContracts<InterchainQueryFactories>): Router {
    for (const key of objKeys(interchainQueryFactories)) {
      if (contracts[key]) {
        return contracts[key] as Router;
      }
    }
    throw new Error('No matching contract found');
  }

  async constructorArgs(_: string, config: RouterConfig): Promise<any> {
    return [config.mailbox];
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
