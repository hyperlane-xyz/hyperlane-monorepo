import debug from 'debug';

import { MerkleTreeHook__factory } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import {
  AggregationHookFactory,
  HookFactories,
  MerkleTreeHookFactory,
  hookFactories,
} from './contracts';
import { AggregationHookConfig, HookConfig, HookType } from './types';

export class HyperlaneHookDeployer extends HyperlaneDeployer<
  HookConfig,
  HookFactories
> {
  constructor(
    multiProvider: MultiProvider,
    readonly aggregationHookFactory: HyperlaneIsmFactory,
    readonly mailboxes: ChainMap<Address>,
  ) {
    super(multiProvider, hookFactories, {
      logger: debug('hyperlane:HyperlaneHookDeployer'),
    });
  }

  async deployContracts(
    chain: ChainName,
    config: HookConfig,
  ): Promise<HyperlaneContracts<HookFactories>> {
    if (config.type === HookType.MERKLE_TREE_HOOK) {
      return this.deployMerleTreeHook(chain, config);
    } else if (config.type === HookType.AGGREGATION) {
      return this.deployAggregationHook(chain, config);
    } else {
      throw new Error(`Unsupported hook type: ${config}`);
    }
  }

  async deployMerleTreeHook(
    chain: ChainName,
    _: HookConfig,
  ): Promise<HyperlaneContracts<MerkleTreeHookFactory>> {
    this.logger(`Deploying MerkleTreeHook to ${chain}`);
    const merkleTreeHook = await this.multiProvider.handleDeploy(
      chain,
      new MerkleTreeHook__factory(),
      [this.mailboxes[chain]],
    );
    return {
      merkleTreeHook: merkleTreeHook,
    };
  }

  async deployAggregationHook(
    chain: ChainName,
    config: AggregationHookConfig,
  ): Promise<HyperlaneContracts<AggregationHookFactory>> {
    this.logger(`Deploying AggregationHook to ${chain} with config ${config}`);
    throw new Error('Not implemented');
  }
}
