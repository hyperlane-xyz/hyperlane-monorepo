import { providers } from 'ethers';

import { Mailbox__factory } from '@hyperlane-xyz/core';
import { Address, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { EvmHookReader } from '../hook/EvmHookReader.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

import { CoreConfig } from './types.js';

interface CoreReader {
  deriveCoreConfig(address: Address): Promise<CoreConfig>;
}

export class EvmCoreReader implements CoreReader {
  provider: providers.Provider;
  evmHookReader: EvmHookReader;
  evmIsmReader: EvmIsmReader;
  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    protected readonly concurrency: number = multiProvider.tryGetRpcConcurrency(
      chain,
    ) ?? DEFAULT_CONTRACT_READ_CONCURRENCY,
  ) {
    this.provider = this.multiProvider.getProvider(chain);
    this.evmHookReader = new EvmHookReader(multiProvider, chain, concurrency);
    this.evmIsmReader = new EvmIsmReader(multiProvider, chain, concurrency);
  }

  /**
   * Derives the core configuration for a given Mailbox address.
   *
   * @param address - The address of the Mailbox contract.
   * @returns A promise that resolves to the CoreConfig object, containing the owner, default ISM, default Hook, and required Hook configurations.
   */
  async deriveCoreConfig(address: Address): Promise<CoreConfig> {
    const mailbox = Mailbox__factory.connect(address, this.provider);
    const [defaultIsm, defaultHook, requiredHook] = await Promise.all([
      mailbox.defaultIsm(),
      mailbox.defaultHook(),
      mailbox.requiredHook(),
    ]);

    // Parallelize each configuration request
    const results = await promiseObjAll(
      objMap(
        {
          owner: mailbox.owner(),
          defaultIsm: this.evmIsmReader.deriveIsmConfig(defaultIsm),
          defaultHook: this.evmHookReader.deriveHookConfig(defaultHook),
          requiredHook: this.evmHookReader.deriveHookConfig(requiredHook),
        },
        async (_, readerCall) => readerCall,
      ),
    );

    return results as CoreConfig;
  }
}
