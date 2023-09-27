import {
  Address,
  objFilter,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

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

export interface HookOptions {
  remoteIsm?: Address;
}

export abstract class HyperlaneInterceptorDeployer<
  Config extends InterceptorConfig,
  HookFactories extends HyperlaneFactories,
> extends HyperlaneDeployer<Config, HookFactories> {
  constructor(
    protected readonly multiProvider: MultiProvider,
    factories: HookFactories,
    options?: DeployerOptions,
  ) {
    super(multiProvider, factories, options);
  }

  async deploy(
    configMap: ChainMap<Config>,
  ): Promise<HyperlaneContractsMap<HookFactories>> {
    const ismConfigMap = objFilter(
      configMap,
      (_, config): config is Config => !isHookConfig(config),
    );
    this.logger(`Deploying ISM contracts to ${Object.keys(ismConfigMap)}`);
    await super.deploy(ismConfigMap);

    const hookConfigMap = objFilter(configMap, (_, config): config is Config =>
      isHookConfig(config),
    );
    this.logger(`Deploying hook contracts to ${Object.keys(hookConfigMap)}`);
    await super.deploy(hookConfigMap);

    // post deploy actions (e.g. setting up authored hook)
    await promiseObjAll(
      objMap(ismConfigMap, (chain, config) => {
        return this.postDeploy(chain, config);
      }),
    );

    this.logger('Interceptor deployment finished successfully');
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
  ): Promise<HyperlaneContracts<HookFactories>>;

  protected abstract deployIsmContracts(
    chain: ChainName,
    config: Config,
  ): Promise<HyperlaneContracts<HookFactories>>;

  protected postDeploy(__: ChainName, _: Config): Promise<void> {
    return Promise.resolve();
  }

  // protected abstract matchConfig(chain: ChainName, config: HookConfig): boolean;
}
