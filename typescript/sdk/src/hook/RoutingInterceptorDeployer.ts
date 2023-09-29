import debug from 'debug';

import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { MultisigIsmConfig } from '../ism/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import {
  RoutingHookFactories,
  RoutingInterceptorFactories,
  RoutingIsmFactories,
  routingHookFactories,
  routingIsmFactories,
} from './contracts';
import { RoutingInterceptorConfig } from './types';

export class RoutingInterceptorDeployer extends HyperlaneDeployer<
  RoutingInterceptorConfig,
  RoutingInterceptorFactories
> {
  constructor(
    multiProvider: MultiProvider,
    readonly ismFactory: HyperlaneIsmFactory,
    readonly mailboxes: ChainMap<Address>,
  ) {
    super(
      multiProvider,
      { ...routingHookFactories, ...routingIsmFactories },
      {
        logger: debug('hyperlane:RoutingInterceptorDeployer'),
      },
    );
  }

  async deployContracts(
    chain: ChainName,
    config: RoutingInterceptorConfig,
  ): Promise<HyperlaneContracts<RoutingInterceptorFactories>> {
    const hookContracts = await this.deployHookContracts(chain, config.hook);
    const ismContracts = await this.deployIsmContracts(chain, config.ism);
    return {
      ...hookContracts,
      ...ismContracts,
    };
  }

  async deployHookContracts(
    chain: ChainName,
    _: RoutingInterceptorConfig,
  ): Promise<HyperlaneContracts<RoutingHookFactories>> {
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
  ): Promise<HyperlaneContracts<RoutingIsmFactories>> {
    this.logger(`Deploying MerkleRootMultisigIsm to ${chain}`);
    const ism = await this.ismFactory.deployMerkleRootMultisigIsm(
      chain,
      config,
    );
    return {
      ism: ism,
    };
  }
}
