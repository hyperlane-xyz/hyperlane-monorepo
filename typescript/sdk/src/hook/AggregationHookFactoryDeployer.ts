import debug from 'debug';

import { isObject } from '@hyperlane-xyz/utils';

import { HyperlaneContracts, HyperlaneContractsMap } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import {
  AggregationHookFactoryFactories,
  aggregationHookFactoryFactories,
} from './contracts';

export class AggregationHookFactoryDeployer extends HyperlaneDeployer<
  boolean,
  AggregationHookFactoryFactories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, aggregationHookFactoryFactories, {
      logger: debug('hyperlane:AggregationHookFactoryDeployer'),
    });
  }

  async deploy(
    config: ChainName[] | ChainMap<boolean>,
  ): Promise<HyperlaneContractsMap<AggregationHookFactoryFactories>> {
    if (isObject(config)) {
      return super.deploy(config as ChainMap<boolean>);
    } else {
      return super.deploy(
        Object.fromEntries((config as ChainName[]).map((c) => [c, true])),
      );
    }
  }

  async deployContracts(
    chain: ChainName,
  ): Promise<HyperlaneContracts<AggregationHookFactoryFactories>> {
    const aggregationHookFactory = await this.deployContract(
      chain,
      'aggregationHookFactory',
      [],
    );
    this.verificationInputs[chain].push({
      name: 'StaticAggregationHook',
      address: await aggregationHookFactory.implementation(),
    });
    return {
      aggregationHookFactory,
    };
  }
}
