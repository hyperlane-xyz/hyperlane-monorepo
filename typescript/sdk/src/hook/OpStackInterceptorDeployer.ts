import debug from 'debug';

import { OPStackHook__factory, OPStackIsm__factory } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

import { HyperlaneInterceptorDeployer } from './HyperlaneInterceptorDeployer';
import {
  OpStackHookFactories,
  OpStackInterceptorFactories,
  OpStackIsmFactories,
  opStackHookFactories,
  opStackIsmFactories,
} from './contracts/opStack';
import {
  NoMetadataIsmConfig,
  OpStackHookConfig,
  OpStackInterceptorConfig,
} from './types';

export class OpStackInterceptorDeployer extends HyperlaneInterceptorDeployer<
  OpStackInterceptorConfig,
  OpStackInterceptorFactories
> {
  constructor(multiProvider: MultiProvider, readonly mailbox: Address) {
    super(
      multiProvider,
      { ...opStackIsmFactories, ...opStackHookFactories },
      {
        logger: debug('hyperlane:OpStackInteceptorDeployer'),
      },
    );
  }

  async deployHookContracts(
    chain: ChainName,
    config: OpStackHookConfig,
  ): Promise<HyperlaneContracts<OpStackHookFactories>> {
    this.logger(`Deploying OpStackHook to ${chain}`);
    const opStackHookFactory = new OPStackHook__factory();
    if (
      !this.deployedContracts[config.destination] ||
      !(
        this.deployedContracts[
          config.destination
        ] as HyperlaneContracts<OpStackIsmFactories>
      ).opStackIsm
    ) {
      throw new Error(`OpStackIsm not deployed on ${config.destination}`);
    }
    const ism = (
      this.deployedContracts[
        config.destination
      ] as HyperlaneContracts<OpStackIsmFactories>
    ).opStackIsm.address;

    const opStackHook = await this.multiProvider.handleDeploy(
      chain,
      opStackHookFactory,
      [this.mailbox, config.destinationDomain, config.nativeBridge, ism],
    );
    this.logger(`OpStackHook successfully deployed on ${chain}`);
    return {
      opStackHook: opStackHook,
    };
  }

  async deployIsmContracts(
    chain: ChainName,
    config: NoMetadataIsmConfig,
  ): Promise<HyperlaneContracts<OpStackIsmFactories>> {
    this.logger(`Deploying OpStackIsm to ${chain}`);
    const opStackIsmFactory = new OPStackIsm__factory();
    const opStackIsm = await this.multiProvider.handleDeploy(
      chain,
      opStackIsmFactory,
      [config.nativeBridge],
    );
    this.logger(`OpStackIsm successfully deployed on ${chain}`);
    return {
      opStackIsm: opStackIsm,
    };
  }

  async postDeploy(chain: string, config: NoMetadataIsmConfig): Promise<void> {
    this.logger(`Setting authorized hook for ISM on ${chain}`);
    const hookAddress = (
      this.deployedContracts[
        config.origin
      ] as HyperlaneContracts<OpStackHookFactories>
    ).opStackHook.address;
    const ism = (
      this.deployedContracts[chain] as HyperlaneContracts<OpStackIsmFactories>
    ).opStackIsm;

    await this.multiProvider.handleTx(
      chain,
      ism.setAuthorizedHook(hookAddress),
    );
    this.logger(`Authorized hook set successfully to ${hookAddress}`);
  }
}
