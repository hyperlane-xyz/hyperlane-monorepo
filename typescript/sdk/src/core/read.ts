import { Address } from '@hyperlane-xyz/utils';

import { EvmHookReader } from '../hook/read.js';
import { EvmIsmReader } from '../ism/read.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import { CoreConfig } from './types.js';

export class EvmCoreReader {
  evmHookReader: EvmHookReader;
  evmIsmReader: EvmIsmReader;
  constructor(
    protected readonly multiProvider: MultiProvider,
    chain: ChainName,
    protected readonly concurrency: number = 20,
  ) {
    this.evmHookReader = new EvmHookReader(multiProvider, chain, concurrency);
    this.evmIsmReader = new EvmIsmReader(multiProvider, chain, concurrency);
  }

  async deriveCoreConfig(address: Address): Promise<CoreConfig> {
    // const requiredHook =
    return {
      owner: 'Owner',
      defaultIsm: await this.evmIsmReader.deriveIsmConfig(address),
      defaultHook: await this.evmHookReader.deriveHookConfig(address),
      requiredHook: await this.evmHookReader.deriveHookConfig(address),
    };
  }
}
