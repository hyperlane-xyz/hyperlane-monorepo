import debug from 'debug';

import { MerkleTreeHook__factory } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { MultisigIsmConfig } from '../ism/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

import {
  MerkleRootHookFactories,
  MerkleRootInterceptorFactories,
  MerkleRootIsmFactories,
  merkleRootHookFactories,
  merkleRootIsmFactories,
} from './contracts';
import { MerkleRootHookConfig, MerkleRootInterceptorConfig } from './types';

export class MerkleRootInterceptorDeployer extends HyperlaneDeployer<
  MerkleRootInterceptorConfig,
  MerkleRootInterceptorFactories
> {
  constructor(
    multiProvider: MultiProvider,
    readonly ismFactory: HyperlaneIsmFactory,
    readonly mailbox: Address,
  ) {
    super(
      multiProvider,
      { ...merkleRootHookFactories, ...merkleRootIsmFactories },
      {
        logger: debug('hyperlane:MerkleRootInterceptorDeployer'),
      },
    );
  }

  async deployContracts(
    chain: ChainName,
    config: MerkleRootInterceptorConfig,
  ): Promise<HyperlaneContracts<MerkleRootInterceptorFactories>> {
    const hookContracts = await this.deployHookContracts(chain, config.hook);
    const ismContracts = await this.deployIsmContracts(chain, config.ism);
    return {
      ...hookContracts,
      ...ismContracts,
    };
  }

  async deployHookContracts(
    chain: ChainName,
    _: MerkleRootHookConfig,
  ): Promise<HyperlaneContracts<MerkleRootHookFactories>> {
    this.logger(`Deploying MerkleRootHook to ${chain}`);
    const merkleTreeFactory = new MerkleTreeHook__factory();
    const merkleTreeHook = await this.multiProvider.handleDeploy(
      chain,
      merkleTreeFactory,
      [this.mailbox],
    );
    this.logger(`MerkleRootHook successfully deployed on ${chain}`);
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
