import { ethers } from 'ethers';

import {
  InterchainAccountRouter,
  MinimalInterchainAccountRouter__factory,
  Router,
} from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../../contracts/types.js';
import { ContractVerifier } from '../../deploy/verify/ContractVerifier.js';
import {
  IcaRouterConfig as InterchainAccountConfig,
  IcaRouterType,
} from '../../ica/types.js';
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

    const routerType = config.routerType ?? IcaRouterType.REGULAR;

    if (routerType === IcaRouterType.REGULAR) {
      assert(
        config.commitmentIsm,
        'commitmentIsm is required for regular ICA router deployments',
      );
      assert(
        config.commitmentIsm.urls.length > 0,
        'Commitment ISM URLs are required for deployment of ICA Routers',
      );
    } else {
      assert(
        !config.commitmentIsm,
        'commitmentIsm must not be set for minimal ICA router deployments',
      );
    }

    const owner = await this.multiProvider.getSignerAddress(chain);
    let interchainAccountRouter: InterchainAccountRouter;

    if (routerType === IcaRouterType.REGULAR) {
      interchainAccountRouter = await this.deployContract(
        chain,
        'interchainAccountRouter',
        [
          config.mailbox,
          ethers.constants.AddressZero,
          owner,
          50_000,
          config.commitmentIsm!.urls,
        ],
      );
    } else {
      this.logger.info(`Deploying MinimalInterchainAccountRouter on ${chain}`);
      interchainAccountRouter = (await this.deployContractFromFactory(
        chain,
        new MinimalInterchainAccountRouter__factory(),
        'minimalInterchainAccountRouter',
        [config.mailbox, ethers.constants.AddressZero, owner],
      )) as unknown as InterchainAccountRouter;
      // deployContractFromFactory doesn't write to cache (unlike deployContract),
      // so persist the address for crash-recovery.
      // Key must match the contractName passed to deployContractFromFactory above
      // so that readCache finds it on recovery.
      // CAST: writeCache is typed to keyof Factories, but deployContractFromFactory
      // operates outside the factory type system with a free-form contractName string.
      // readCache already accepts arbitrary string keys — this just matches it.
      this.writeCache(
        chain,
        'minimalInterchainAccountRouter' as keyof InterchainAccountFactories,
        interchainAccountRouter.address,
      );
    }

    // Approve fee tokens for hooks if configured
    if (config.feeTokenApprovals?.length) {
      this.logger.info(
        `Approving ${config.feeTokenApprovals.length} fee token(s) for hooks on ${chain}...`,
      );

      for (const approval of config.feeTokenApprovals) {
        this.logger.debug(
          `Approving fee token ${approval.feeToken} for hook ${approval.hook}`,
        );
        await this.multiProvider.handleTx(
          chain,
          interchainAccountRouter.approveFeeTokenForHook(
            approval.feeToken,
            approval.hook,
          ),
        );
      }
    }

    return {
      interchainAccountRouter,
    };
  }
}
