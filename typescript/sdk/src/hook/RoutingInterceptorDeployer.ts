import debug from 'debug';

import { DomainRoutingHook, DomainRoutingIsm } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { RoutingIsmConfig } from '../ism/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { MerkleRootInterceptorDeployer } from './MerkleRootInterceptorDeployer';
import {
  RoutingHookFactories,
  RoutingInterceptorFactories,
  RoutingIsmFactories,
  routingHookFactories,
  routingIsmFactories,
} from './contracts';
import { RoutingHookConfig, RoutingInterceptorConfig } from './types';

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
    config: RoutingHookConfig,
  ): Promise<HyperlaneContracts<RoutingHookFactories>> {
    this.logger(`Deploying DomainRoutingHook to ${chain}`);
    const subConfigs: DomainRoutingHook.HookConfig[] = [];

    for (const destination in config.domains) {
      const merkleDeployer = new MerkleRootInterceptorDeployer(
        this.multiProvider,
        this.ismFactory,
        this.mailboxes,
      );
      const hook = await merkleDeployer.deployHookContracts(
        chain,
        config.domains[destination],
      );
      subConfigs.push({
        destination: destination,
        hook: hook.hook,
      });
    }
    const routingHook = await this.deployContract(chain, 'hook', [
      this.mailboxes[chain],
    ]);
    await this.multiProvider.handleTx(chain, routingHook.setHooks(subConfigs));
    return {
      hook: routingHook,
    };
  }

  async deployIsmContracts(
    chain: ChainName,
    config: RoutingIsmConfig,
  ): Promise<HyperlaneContracts<RoutingIsmFactories>> {
    this.logger(`Deploying DomainRoutingIsm to ${chain}`);
    const ism = await this.ismFactory.deploy(chain, config);
    return {
      ism: ism as DomainRoutingIsm,
    };
  }
}
