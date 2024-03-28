import { ethers } from 'ethers';

import { Router } from '@hyperlane-xyz/core';

import { HyperlaneContracts } from '../../contracts/types';
import { ContractVerifier } from '../../deploy/verify/ContractVerifier';
import { MultiProvider } from '../../providers/MultiProvider';
import { ProxiedRouterDeployer } from '../../router/ProxiedRouterDeployer';
import { ProxiedRouterConfig, RouterConfig } from '../../router/types';
import { ChainName } from '../../types';

import {
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts';

export type InterchainAccountConfig = ProxiedRouterConfig;

export class InterchainAccountDeployer extends ProxiedRouterDeployer<
  InterchainAccountConfig,
  InterchainAccountFactories
> {
  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
  ) {
    super(multiProvider, interchainAccountFactories, {
      contractVerifier,
    });
  }
  routerContractName(): string {
    return 'InterchainAccountRouter';
  }

  routerContractKey<K extends keyof InterchainAccountFactories>(): K {
    return 'interchainAccountRouter' as K;
  }

  router(contracts: HyperlaneContracts<InterchainAccountFactories>): Router {
    return contracts.interchainAccountRouter;
  }

  async constructorArgs(_: string, config: RouterConfig): Promise<any> {
    return [config.mailbox];
  }

  async initializeArgs(chain: string, config: RouterConfig): Promise<any> {
    const owner = await this.multiProvider.getSignerAddress(chain);
    return [
      config.hook ?? ethers.constants.AddressZero,
      config.interchainSecurityModule! as string, // deployed in deployContracts
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
