import { objFilter } from '@hyperlane-xyz/utils';

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
import { PostDispatchHookConfig } from './types';

export abstract class HyperlaneInterceptorDeployer<
  HookConfig extends PostDispatchHookConfig,
  HookFactories extends HyperlaneFactories,
> extends HyperlaneDeployer<HookConfig, HookFactories> {
  constructor(
    multiProvider: MultiProvider,
    factories: HookFactories,
    options?: DeployerOptions,
  ) {
    super(multiProvider, factories, options);
  }

  async deploy(
    configMap: ChainMap<HookConfig>,
  ): Promise<HyperlaneContractsMap<HookFactories>> {
    // TODO: uncomment when ISMs are implemented
    // const ismConfigMap = objFilter(
    //   configMap,
    //   (_, config: IsmConfig): config is IsmConfig => !isHookConfig(config),
    // );
    // await super.deploy(ismConfigMap);

    // deploy Hooks next
    const hookConfigMap = objFilter(
      configMap,
      (_, config: HookConfig): config is HookConfig => isHookConfig(config),
    );
    await super.deploy(hookConfigMap);

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
    config: HookConfig,
  ): Promise<HyperlaneContracts<HookFactories>> {
    this.logger(`Deploying ${config.hookContractType} on ${chain}`);
    if (isHookConfig(config)) {
      return this.deployHookContracts(chain, config);
    } else {
      throw new Error('ISM as object unimplemented');
    }
  }

  protected abstract deployHookContracts(
    chain: ChainName,
    config: HookConfig,
  ): Promise<HyperlaneContracts<HookFactories>>;

  //   protected abstract deployIsmContracts(
  //     chain: ChainName,
  //     config: IsmConfig,
  //   ): Promise<HyperlaneContracts<PostDispatchHookFactories>>;
  // }
}
