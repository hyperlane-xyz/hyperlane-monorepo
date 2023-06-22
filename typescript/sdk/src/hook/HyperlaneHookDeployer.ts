import debug from 'debug';

import { OptimismISM, OptimismMessageHook } from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

import {
  MessageHookFactories,
  NoMetadataIsmFactories,
  messageHookFactories,
  noMetadataIsmFactories,
} from './contracts';
import { MessageHookConfig, NoMetadataIsmConfig } from './types';

export class HyperlaneMessageHookDeployer extends HyperlaneDeployer<
  MessageHookConfig,
  MessageHookFactories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, messageHookFactories, {
      logger: debug('hyperlane:MessageHookDeployer'),
    });
  }

  async deployOptimismMessageHook(
    chain: ChainName,
    destinationDomain: number,
    nativeBridge: types.Address,
    optimismISM: types.Address,
  ): Promise<OptimismMessageHook> {
    const optimismMessageHook = await this.deployContract(
      chain,
      'optimismMessageHook',
      [destinationDomain, nativeBridge, optimismISM],
    );
    return optimismMessageHook;
  }

  async deployContracts(
    chain: ChainName,
    hookConfig: MessageHookConfig,
  ): Promise<HyperlaneContracts<MessageHookFactories>> {
    this.logger('deploying optimismMessageHook');
    const optimismMessageHook = await this.deployOptimismMessageHook(
      chain,
      hookConfig.destinationDomain,
      hookConfig.nativeBridge,
      hookConfig.remoteIsm,
    );

    return {
      optimismMessageHook,
    };
  }
}

export class HyperlaneNoMetadataIsmDeployer extends HyperlaneDeployer<
  NoMetadataIsmConfig,
  NoMetadataIsmFactories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, noMetadataIsmFactories, {
      logger: debug('hyperlane:NoMetadataIsmDeployer'),
    });
  }

  async deployOptimismISM(
    chain: ChainName,
    nativeBridge: types.Address,
  ): Promise<OptimismISM> {
    const optimismISM = await this.deployContract(chain, 'optimismISM', [
      nativeBridge,
    ]);
    return optimismISM;
  }

  async deployContracts(
    chain: ChainName,
    hookConfig: NoMetadataIsmConfig,
  ): Promise<HyperlaneContracts<NoMetadataIsmFactories>> {
    this.logger('deploying optimismISM');
    const optimismISM = await this.deployOptimismISM(
      chain,
      hookConfig.nativeBridge,
    );
    return {
      optimismISM,
    };
  }
}
