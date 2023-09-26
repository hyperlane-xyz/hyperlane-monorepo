import { Address, objFilter } from '@hyperlane-xyz/utils';

import {
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
} from '../contracts/types';
import {
  DeployerOptions,
  HyperlaneDeployer,
} from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { isHookConfig } from './config';
import { InterceptorConfig } from './types';

export abstract class HyperlaneInterceptorDeployer<
  Config extends InterceptorConfig,
  HookFactories extends HyperlaneFactories,
> extends HyperlaneDeployer<Config, HookFactories> {
  constructor(
    multiProvider: MultiProvider,
    factories: HookFactories,
    mailbox: Address,
    options?: DeployerOptions,
  ) {
    super(multiProvider, factories, options);
  }

  async deploy(
    configMap: ChainMap<Config>,
  ): Promise<HyperlaneContractsMap<HookFactories>> {
    // TODO: uncomment when ISMs are implemented
    const ismConfigMap = objFilter(
      configMap,
      (_, config): config is Config => !isHookConfig(config),
    );
    await super.deploy(ismConfigMap);

    const hookConfigMap = objFilter(configMap, (_, config): config is Config =>
      isHookConfig(config),
    );
    await super.deploy(hookConfigMap);

    // deploy Hooks next
    // TODO: post deploy steps
    // configure ISMs with authorized hooks
    // await promiseObjAll(
    //   objMap(hookConfigMap, (hookChain, hookConfig) => {
    //     const hookAddress = this.deployedContracts[hookChain].hook.address;
    //     const ism = this.deployedContracts[hookConfig.destination].ism;
    //     return this.multiProvider.handleTx(
    //       hookConfig.destination,
    //       ism.setAuthorizedHook(hookAddress),
    //     );
    //   }),
    // );

    return this.deployedContracts;
  }

  async deployContracts(
    chain: ChainName,
    config: Config,
  ): Promise<HyperlaneContracts<HookFactories>> {
    if (isHookConfig(config)) {
      return this.deployHookContracts(chain, config);
    } else {
      return this.deployIsmContracts(chain, config);
    }
  }

  protected abstract deployHookContracts(
    chain: ChainName,
    config: Config,
    mailbox?: Address,
  ): Promise<HyperlaneContracts<HookFactories>>;

  protected abstract deployIsmContracts(
    chain: ChainName,
    config: Config,
  ): Promise<HyperlaneContracts<HookFactories>>;

  // protected abstract matchConfig(chain: ChainName, config: HookConfig): boolean;
}
