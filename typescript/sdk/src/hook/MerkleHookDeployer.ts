import debug from 'debug';

import { MerkleTreeHook__factory } from '@hyperlane-xyz/core';

import { HyperlaneContracts } from '../contracts/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

import { HyperlaneInterceptorDeployer } from './HyperlaneInterceptorDeployer';
import { MerkleRootHookFactories } from './contracts';
import { MerkleTreeHookConfig } from './types';

export class MerkleTreeInterceptorDeployer extends HyperlaneInterceptorDeployer<
  MerkleTreeHookConfig,
  MerkleRootHookFactories
> {
  constructor(
    multiProvider: MultiProvider,
    factories: MerkleRootHookFactories,
  ) {
    super(multiProvider, factories, {
      logger: debug('hyperlane:MerkleTreeInterceptorDeployer'),
    });
  }

  async deployHookContracts(
    chain: ChainName,
    config: MerkleTreeHookConfig,
  ): Promise<HyperlaneContracts<MerkleRootHookFactories>> {
    this.logger(`Deploying Merkle Tree Hook to ${chain}`);
    const merkleTreeFactory = new MerkleTreeHook__factory();
    const merkleTreeHook = await this.multiProvider.handleDeploy(
      chain,
      merkleTreeFactory,
      [config.mailbox],
    );

    return {
      hook: merkleTreeHook,
    };
  }
}
