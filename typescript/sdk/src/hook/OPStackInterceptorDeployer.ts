import debug from 'debug';

import { OPStackHook__factory, OPStackIsm__factory } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import {
  OPStackHookFactories,
  OPStackInterceptorFactories,
  OPStackIsmFactories,
  opStackHookFactories,
  opStackIsmFactories,
} from './contracts';
import {
  NoMetadataIsmConfig,
  OPStackHookConfig,
  OPStackInterceptorConfig,
} from './types';
// TODO fix this
import { getDestinationIsmConfig } from './utils';

export class OPStackInterceptorDeployer extends HyperlaneDeployer<
  OPStackInterceptorConfig,
  OPStackInterceptorFactories
> {
  constructor(
    multiProvider: MultiProvider,
    readonly ismFactory: HyperlaneIsmFactory,
    readonly mailboxes: ChainMap<Address>,
  ) {
    super(
      multiProvider,
      { ...opStackHookFactories, ...opStackIsmFactories },
      {
        logger: debug('hyperlane:OPStackInterceptorDeployer'),
      },
    );
  }

  async deployContracts(
    chain: ChainName,
    config: OPStackInterceptorConfig,
  ): Promise<HyperlaneContracts<OPStackInterceptorFactories>> {
    let hookContracts, ismContracts;
    if (config.hook) {
      const destinationConfig = getDestinationIsmConfig(
        config.hook.destination,
      );
      // deploy ISM
      ismContracts = await this.deployIsmContracts(chain, destinationConfig);

      hookContracts = await this.deployHookContracts(chain, config.hook);
    }

    return {
      ...hookContracts,
      ...ismContracts,
    };
  }

  async deployHookContracts(
    chain: ChainName,
    config: OPStackHookConfig,
  ): Promise<HyperlaneContracts<OPStackHookFactories>> {
    this.logger(`Deploying OPStackHook to ${chain}`);
    const hookFactory = new OPStackHook__factory();
    const remoteIsm = this.deployedContracts[config.destination].ism.address;
    // TODO: use deployContract
    const hook = await this.multiProvider.handleDeploy(chain, hookFactory, [
      this.mailboxes[chain],
      config.destinationDomain,
      remoteIsm,
      config.nativeBridge,
    ]);
    this.logger(`OPStackHook successfully deployed on ${chain}`);
    return {
      hook: hook,
    };
  }

  async deployIsmContracts(
    chain: ChainName,
    config: NoMetadataIsmConfig,
  ): Promise<HyperlaneContracts<OPStackIsmFactories>> {
    this.logger(`Deploying OPStackIsm to ${chain}`);
    const ismFactory = new OPStackIsm__factory();
    const ism = await this.multiProvider.handleDeploy(chain, ismFactory, [
      config.nativeBridge,
    ]);

    this.logger(`OPStackIsm successfully deployed on ${chain}`);
    return {
      ism: ism,
    };
  }
}
