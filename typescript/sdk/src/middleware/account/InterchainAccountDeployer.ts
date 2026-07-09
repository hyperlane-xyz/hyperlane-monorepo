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
import { LEGACY_EVM_INTERCHAIN_ACCOUNT_ROUTER_BYTECODE } from './legacyEvmBytecode.js';

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
      const constructorArgs: Parameters<
        InterchainAccountFactories['interchainAccountRouter']['deploy']
      > = [
        config.mailbox,
        ethers.constants.AddressZero,
        owner,
        50_000,
        config.commitmentIsm!.urls,
      ];

      if (config.legacyEvmBytecode) {
        this.logger.info(
          `Deploying InterchainAccountRouter on ${chain} using legacy-EVM-compiled bytecode`,
        );
        // CAST: same ABI as the default build (verified identical at codegen
        // time), just bytecode compiled for an older EVM version. The plain
        // ethers.ContractFactory here doesn't carry the typed deploy() args,
        // but the constructor signature is unchanged, so the cast is safe.
        interchainAccountRouter = (await this.deployContractFromFactory(
          chain,
          new ethers.ContractFactory(
            interchainAccountFactories.interchainAccountRouter.interface,
            LEGACY_EVM_INTERCHAIN_ACCOUNT_ROUTER_BYTECODE,
          ),
          'interchainAccountRouter',
          constructorArgs,
        )) as unknown as InterchainAccountRouter;
        // deployContractFromFactory doesn't write to cache (unlike
        // deployContract), so persist the address for crash-recovery, using
        // the same key deployContract would use so a retry without this
        // flag still finds it.
        this.writeCache(
          chain,
          'interchainAccountRouter',
          interchainAccountRouter.address,
        );
      } else {
        interchainAccountRouter = await this.deployContract(
          chain,
          'interchainAccountRouter',
          constructorArgs,
        );
      }
    } else {
      this.logger.info(`Deploying MinimalInterchainAccountRouter on ${chain}`);
      // CAST: MinimalInterchainAccountRouter shares the same function selectors used
      // by the SDK (callRemoteWithOverrides, getDeployedInterchainAccount, isms, etc.).
      // The EVM dispatches by selector so the cast is safe at runtime, but TS types differ.
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
