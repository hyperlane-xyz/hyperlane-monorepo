import debug from 'debug';

import { objFilter, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../contracts/types';
import { CoreFactories } from '../core/contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { isHookConfig, isISMConfig } from './config';
import { OptimismHookFactories, optimismHookFactories } from './contracts';
import { HookConfig, MessageHookConfig, NoMetadataIsmConfig } from './types';

// TODO: make generic from optimism hooks
export class HyperlaneHookDeployer extends HyperlaneDeployer<
  HookConfig,
  OptimismHookFactories
> {
  constructor(
    multiProvider: MultiProvider,
    public core: HyperlaneAddressesMap<CoreFactories>,
  ) {
    super(multiProvider, optimismHookFactories, {
      logger: debug('hyperlane:HookDeployer'),
    });
  }

  async deploy(
    configMap: ChainMap<HookConfig>,
  ): Promise<HyperlaneContractsMap<OptimismHookFactories>> {
    // deploy ISMs first
    const ismConfigMap = objFilter(
      configMap,
      (_, config): config is NoMetadataIsmConfig => isISMConfig(config),
    );
    await super.deploy(ismConfigMap);

    // deploy Hooks next
    const hookConfigMap = objFilter(
      configMap,
      (_, config): config is MessageHookConfig => isHookConfig(config),
    );
    await super.deploy(hookConfigMap);

    // configure ISMs with authorized hooks
    await promiseObjAll(
      objMap(hookConfigMap, (hookChain, hookConfig) => {
        const hookAddress = this.deployedContracts[hookChain].hook.address;
        const ism = this.deployedContracts[hookConfig.destination].ism;
        return this.multiProvider.handleTx(
          hookConfig.destination,
          ism.setAuthorizedHook(hookAddress),
        );
      }),
    );

    return this.deployedContracts;
  }

  async deployContracts(
    chain: ChainName,
    config: HookConfig,
  ): Promise<HyperlaneContracts<OptimismHookFactories>> {
    this.logger(`Deploying ${config.hookContractType} on ${chain}`);
    if (isISMConfig(config)) {
      const ism = await this.multiProvider.handleDeploy(
        chain,
        this.factories.ism,
        [config.nativeBridge],
      );
      // @ts-ignore
      return { ism, hook: undefined };
    } else if (isHookConfig(config)) {
      const remoteIsm = this.deployedContracts[config.destination].ism;
      if (!remoteIsm) {
        throw new Error(`Remote ISM not found for ${config.destination}`);
      }

      const mailbox = this.core[chain].mailbox;
      if (!mailbox) {
        throw new Error(`Mailbox not found for ${chain}`);
      }
      const destinationDomain = this.multiProvider.getDomainId(
        config.destination,
      );

      const hook = await this.multiProvider.handleDeploy(
        chain,
        this.factories.hook,
        [mailbox, destinationDomain, remoteIsm.address, config.nativeBridge],
      );

      // @ts-ignore
      return { hook, ism: undefined };
    } else {
      throw new Error(`Invalid config type: ${config}`);
    }
  }
}
