import {
  InterchainAccountRouter__factory,
  InterchainQueryRouter__factory,
} from '@hyperlane-xyz/core';
import { RouterInterface } from '@hyperlane-xyz/core/dist/contracts/Router';

import { HyperlaneCore } from '../../core/HyperlaneCore';
import {
  InterchainAccountContracts,
  InterchainAccountFactories,
  InterchainQueryContracts,
  InterchainQueryFactories,
  interchainAccountFactories,
  interchainQueryFactories,
} from '../../middleware';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterContracts, RouterFactories } from '../../router';
import { ChainMap, ChainName } from '../../types';
import { HyperlaneRouterDeployer } from '../router/HyperlaneRouterDeployer';
import { RouterConfig } from '../router/types';

export type InterchainAccountConfig = RouterConfig;

export abstract class MiddlewareRouterDeployer<
  Chain extends ChainName,
  MiddlewareRouterConfig extends RouterConfig,
  MiddlewareRouterContracts extends RouterContracts,
  MiddlewareFactories extends RouterFactories,
> extends HyperlaneRouterDeployer<
  Chain,
  MiddlewareRouterConfig,
  MiddlewareRouterContracts,
  MiddlewareFactories
> {
  getInitArgs(
    config: MiddlewareRouterConfig,
    routerInterface: RouterInterface,
  ): string {
    const initArgs: [string, string] | [string, string, string] = [
      config.mailbox,
      config.interchainGasPaymaster,
    ];
    let functionName = 'initialize(address,address)';
    if (config.interchainSecurityModule) {
      functionName = 'initialize(address,address,address)';
      initArgs.push(config.interchainSecurityModule);
    }

    // @ts-ignore Compiler can't infer correct signature
    return routerInterface.encodeFunctionData(functionName, initArgs);
  }
}

export class InterchainAccountDeployer<
  Chain extends ChainName,
> extends MiddlewareRouterDeployer<
  Chain,
  InterchainAccountConfig,
  InterchainAccountContracts,
  InterchainAccountFactories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, InterchainAccountConfig>,
    protected core: HyperlaneCore<Chain>,
    protected create2salt = 'asdasdsd',
  ) {
    super(multiProvider, configMap, interchainAccountFactories, {});
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(
    chain: Chain,
    config: InterchainAccountConfig,
  ): Promise<InterchainAccountContracts> {
    const initCalldata = this.getInitArgs(
      config,
      InterchainAccountRouter__factory.createInterface(),
    );
    const router = await this.deployContract(chain, 'router', [], {
      create2Salt: this.create2salt + 'router',
      initCalldata,
    });
    return {
      router,
    };
  }
}

export type InterchainQueryConfig = RouterConfig;

export class InterchainQueryDeployer<
  Chain extends ChainName,
> extends MiddlewareRouterDeployer<
  Chain,
  InterchainQueryConfig,
  InterchainQueryContracts,
  InterchainQueryFactories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, InterchainQueryConfig>,
    protected core: HyperlaneCore<Chain>,
    // TODO replace salt with 'hyperlane' before next redeploy
    protected create2salt = 'asdasdsd',
  ) {
    super(multiProvider, configMap, interchainQueryFactories, {});
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(
    chain: Chain,
    config: InterchainQueryConfig,
  ): Promise<InterchainQueryContracts> {
    const initCalldata = this.getInitArgs(
      config,
      InterchainQueryRouter__factory.createInterface(),
    );
    const router = await this.deployContract(chain, 'router', [], {
      create2Salt: this.create2salt + 'router',
      initCalldata,
    });
    return {
      router,
    };
  }
}
