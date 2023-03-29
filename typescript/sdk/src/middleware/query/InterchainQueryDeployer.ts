import {
  InterchainQueryRouter,
  InterchainQueryRouter__factory,
} from '@hyperlane-xyz/core';

import { MultiProvider } from '../../providers/MultiProvider';
import { RouterConfig } from '../../router/types';
import { ChainMap } from '../../types';
import { MiddlewareRouterDeployer } from '../MiddlewareRouterDeployer';

import {
  InterchainQueryContracts,
  InterchainQueryFactories,
  interchainQueryFactories,
} from './contracts';

export type InterchainQueryConfig = RouterConfig;

export class InterchainQueryDeployer extends MiddlewareRouterDeployer<
  InterchainQueryConfig,
  InterchainQueryContracts,
  InterchainQueryFactories,
  InterchainQueryRouter__factory
> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<InterchainQueryConfig>,
    create2salt = 'queryrouter2',
  ) {
    super(multiProvider, configMap, interchainQueryFactories, create2salt);
  }

  routerContractName(): string {
    return 'interchainQueryRouter';
  }

  router(contracts: InterchainQueryContracts): InterchainQueryRouter {
    return contracts.interchainQueryRouter.contract;
  }
}
