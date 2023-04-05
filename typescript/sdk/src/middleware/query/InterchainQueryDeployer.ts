import { InterchainQueryRouter__factory } from '@hyperlane-xyz/core';

import { MultiProvider } from '../../providers/MultiProvider';
import { RouterConfig } from '../../router/types';
import { ChainMap } from '../../types';
import { MiddlewareRouterDeployer } from '../MiddlewareRouterDeployer';

import {
  InterchainQueryFactories,
  interchainQueryFactories,
} from './contracts';

export type InterchainQueryConfig = RouterConfig;

export class InterchainQueryDeployer extends MiddlewareRouterDeployer<
  InterchainQueryConfig,
  InterchainQueryFactories,
  InterchainQueryRouter__factory
> {
  readonly routerContractName = 'interchainQueryRouter';

  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<InterchainQueryConfig>,
  ) {
    super(multiProvider, configMap, interchainQueryFactories);
  }
}
