import { ethers } from 'ethers';

import {
  GasRouter,
  InterchainAccountRouter__factory,
  InterchainQueryRouter__factory,
} from '@hyperlane-xyz/core';

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
import { objMap } from '../../utils/objects';
import { GasRouterDeployer } from '../router/GasRouterDeployer';
import { GasRouterConfig, RouterConfig } from '../router/types';

export type InterchainAccountConfig = RouterConfig;

export abstract class MiddlewareRouterDeployer<
  Chain extends ChainName,
  MiddlewareRouterConfig extends RouterConfig,
  MiddlewareRouterContracts extends RouterContracts<GasRouter>,
  MiddlewareFactories extends RouterFactories<GasRouter>,
> extends GasRouterDeployer<
  Chain,
  GasRouterConfig,
  MiddlewareRouterContracts,
  MiddlewareFactories
> {
  getInitArgs(
    config: MiddlewareRouterConfig,
    routerInterface: ethers.utils.Interface,
  ): string {
    return routerInterface.encodeFunctionData('initialize', [
      config.mailbox,
      config.interchainGasPaymaster,
      config.interchainSecurityModule ?? ethers.constants.AddressZero,
      config.owner,
    ]);
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
    protected create2salt = 'hyperlane',
    protected gasOverhead = 112000, // from forge test -vvvv InterchainAccountRouter::handle
  ) {
    const gasConfigMap = objMap(configMap, (_, config) => ({
      ...config,
      gasOverhead,
    }));
    super(multiProvider, gasConfigMap, interchainAccountFactories, {});
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
    protected create2salt = 'hyperlane',
    protected gasOverhead = 310000, // from forge test -vvvv InterchainAccountRouter::handle
  ) {
    const gasConfigMap = objMap(configMap, (_, config) => ({
      ...config,
      gasOverhead,
    }));
    super(multiProvider, gasConfigMap, interchainQueryFactories, {});
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
