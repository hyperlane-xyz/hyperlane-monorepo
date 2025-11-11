import { ethers } from 'ethers';

import { Router } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../../contracts/types.js';
import { ContractVerifier } from '../../deploy/verify/ContractVerifier.js';
import { IcaRouterConfig as InterchainAccountConfig } from '../../ica/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { HyperlaneRouterDeployer } from '../../router/HyperlaneRouterDeployer.js';
import { ChainName } from '../../types.js';

import {
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts.js';

export class InterchainAccountDeployer extends HyperlaneRouterDeployer<
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

  router(contracts: HyperlaneContracts<InterchainAccountFactories>): Router {
    return contracts.interchainAccountRouter;
  }

  async deployContracts(
    chain: ChainName,
    config: InterchainAccountConfig,
  ): Promise<HyperlaneContracts<InterchainAccountFactories>> {
    if (config.interchainSecurityModule) {
      throw new Error('Configuration of ISM not supported in ICA deployer');
    }

    assert(
      config.commitmentIsm.urls.length > 0,
      'Commitment ISM URLs are required for deployment of ICA Routers. Please provide at least one URL in the commitmentIsm.urls array.',
    );

    const owner = await this.multiProvider.getSignerAddress(chain);
    const interchainAccountRouter = await this.deployContract(
      chain,
      'interchainAccountRouter',
      [
        config.mailbox,
        ethers.constants.AddressZero,
        owner,
        50_000,
        config.commitmentIsm.urls,
      ],
    );

    return {
      interchainAccountRouter,
    };
  }
}
