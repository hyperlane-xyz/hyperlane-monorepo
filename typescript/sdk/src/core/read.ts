import { providers } from 'ethers';

import { Mailbox__factory } from '@hyperlane-xyz/core';
import { Address, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { EvmHookReader } from '../hook/read.js';
import { EvmIsmReader } from '../ism/read.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import { CoreConfig } from './types.js';

export class EvmCoreReader {
  provider: providers.Provider;
  evmHookReader: EvmHookReader;
  evmIsmReader: EvmIsmReader;
  constructor(
    protected readonly multiProvider: MultiProvider,
    chain: ChainName,
    protected readonly concurrency: number = 20,
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
    const defaultIsm = await mailbox.defaultIsm();
    const defaultHook = await mailbox.defaultHook();
    const requiredHook = await mailbox.requiredHook();

    // Parallelize each property call request
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
