import { ethers } from 'ethers';

import { Router } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../../contracts/types.js';
import { ContractVerifier } from '../../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ProxiedRouterDeployer } from '../../router/ProxiedRouterDeployer.js';
import {
  MailboxAddress,
  ProxiedRouterConfig,
  RouterConfig,
} from '../../router/types.js';
import { ChainName } from '../../types.js';

import {
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts.js';

export type InterchainAccountConfig = ProxiedRouterConfig & MailboxAddress;

export class InterchainAccountDeployer extends ProxiedRouterDeployer<
  InterchainAccountConfig,
  InterchainAccountFactories
> {
  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
    concurrentDeploy?: boolean,
  ) {
    super(multiProvider, interchainAccountFactories, {
      contractVerifier,
      concurrentDeploy,
    });
  }
  routerContractName(): string {
    return 'interchainAccountRouter';
  }

  routerContractKey<K extends keyof InterchainAccountFactories>(): K {
    return 'interchainAccountRouter' as K;
  }

  router(contracts: HyperlaneContracts<InterchainAccountFactories>): Router {
    return contracts.interchainAccountRouter;
  }

  async constructorArgs<K extends keyof InterchainAccountFactories>(
    _: string,
    config: RouterConfig,
  ): Promise<Parameters<InterchainAccountFactories[K]['deploy']>> {
    return [config.mailbox] as any;
  }

  async initializeArgs(chain: string, config: RouterConfig): Promise<any> {
    const owner = await this.multiProvider.getSignerAddress(chain);
    if (config.interchainSecurityModule) {
      assert(
        typeof config.interchainSecurityModule === 'string',
        'ISM objects not supported in ICA deployer',
      );
    }

    return [
      config.hook ?? ethers.constants.AddressZero,
      config.interchainSecurityModule!,
      owner,
    ];
  }

  async deployContracts(
    chain: ChainName,
    config: InterchainAccountConfig,
  ): Promise<HyperlaneContracts<InterchainAccountFactories>> {
    if (config.interchainSecurityModule) {
      throw new Error('Configuration of ISM not supported in ICA deployer');
    }

    const interchainAccountIsm = await this.deployContract(
      chain,
      'interchainAccountIsm',
      [config.mailbox],
    );
    const modifiedConfig = {
      ...config,
      interchainSecurityModule: interchainAccountIsm.address,
    };
    const contracts = await super.deployContracts(chain, modifiedConfig);

    return {
      ...contracts,
      interchainAccountIsm,
    };
  }
}
