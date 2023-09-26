import debug from 'debug';

import { MerkleTreeHook__factory } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { MultisigIsmConfig } from '../ism/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

import { HyperlaneInterceptorDeployer } from './HyperlaneInterceptorDeployer';
import {
  MerkleRootHookFactories,
  MerkleRootInterceptorFactories,
  MerkleRootIsmFactories,
  merkleRootHookFactories,
} from './contracts';
import { MerkleRootInterceptorConfig, MerkleTreeHookConfig } from './types';

export class MerkleRootInterceptorDeployer extends HyperlaneInterceptorDeployer<
  MerkleRootInterceptorConfig,
  MerkleRootInterceptorFactories
> {
  constructor(
    multiProvider: MultiProvider,
    readonly ismFactory: HyperlaneIsmFactory,
    readonly mailbox: Address,
  ) {
    super(multiProvider, merkleRootHookFactories, mailbox, {
      logger: debug('hyperlane:MerkleTreeInterceptorDeployer'),
    });
  }

  async deployHookContracts(
    chain: ChainName,
    _: MerkleTreeHookConfig,
  ): Promise<HyperlaneContracts<MerkleRootHookFactories>> {
    this.logger(`Deploying Merkle Tree Hook to ${chain}`);
    const merkleTreeFactory = new MerkleTreeHook__factory();
    const merkleTreeHook = await this.multiProvider.handleDeploy(
      chain,
      merkleTreeFactory,
      [this.mailbox],
    );

    return {
      hook: merkleTreeHook,
    };
  }

  async deployIsmContracts(
    chain: ChainName,
    config: MultisigIsmConfig,
  ): Promise<HyperlaneContracts<MerkleRootIsmFactories>> {
    const ism = await this.ismFactory.deployMerkleRootMultisigIsm(
      chain,
      config,
    );

    return {
      ism: ism,
    };
  }
}
