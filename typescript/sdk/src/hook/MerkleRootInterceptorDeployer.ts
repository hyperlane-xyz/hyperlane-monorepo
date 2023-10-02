import debug from 'debug';

import {
  StaticMerkleRootMultisigIsm,
  StaticMessageIdMultisigIsm,
} from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { ModuleType, MultisigIsmConfig } from '../ism/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import {
  MerkleRootHookFactories,
  MerkleRootInterceptorFactories,
  MultisigIsmFactories,
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
    readonly mailboxes: ChainMap<Address>,
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
    const merkleTreeHook = await this.deployContract(chain, 'hook', [
      this.mailboxes[chain],
    ]);
    return {
      hook: merkleTreeHook,
    };
  }

  async deployIsmContracts(
    chain: ChainName,
    config: MultisigIsmConfig,
  ): Promise<HyperlaneContracts<MultisigIsmFactories>> {
    const ism = await this.ismFactory.deploy(chain, config);
    if (config.type === ModuleType.MERKLE_ROOT_MULTISIG) {
      this.logger(`Deploying StaticMerkleRootMultisigIsm to ${chain}`);
      return {
        ism: ism as StaticMerkleRootMultisigIsm,
      };
    } else if (config.type === ModuleType.MESSAGE_ID_MULTISIG) {
      this.logger(`Deploying StaticMessageIdMultisigIsm to ${chain}`);
      return {
        ism: ism as StaticMessageIdMultisigIsm,
      };
    } else {
      throw new Error(
        `Unexpected ISM type ${config.type} for MerkleRootInterceptorDeployer`,
      );
    }
  }
}
