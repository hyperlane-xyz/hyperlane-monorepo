import { TransactionReceipt } from '@ethersproject/providers';
import { ethers } from 'ethers';

import {
  Address,
  objMap,
  pollAsync,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { DerivedHookConfigWithAddress, EvmHookReader } from '../hook/read.js';
import { BaseMetadataBuilder } from '../ism/metadata/builder.js';
import { DerivedIsmConfigWithAddress, EvmIsmReader } from '../ism/read.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import { HyperlaneCore } from './HyperlaneCore.js';
import { DispatchedMessage } from './types.js';

export class HyperlaneRelayer {
  private multiProvider: MultiProvider;
  private metadataBuilder: BaseMetadataBuilder;

  private hookCache:
    | Record<ChainName, Record<Address, DerivedHookConfigWithAddress>>
    | undefined;
  private ismCache:
    | Record<ChainName, Record<Address, DerivedIsmConfigWithAddress>>
    | undefined;

  public readonly logger;

  constructor(protected readonly core: HyperlaneCore, caching = true) {
    this.logger = core.logger.child({ module: 'Relayer' });
    this.metadataBuilder = new BaseMetadataBuilder(core);
    this.multiProvider = core.multiProvider;
    if (caching) {
      this.hookCache = {};
      this.ismCache = {};
    }
  }

  async getHookConfig(
    chain: ChainName,
    hook: Address,
  ): Promise<DerivedHookConfigWithAddress> {
    const config =
      this.hookCache?.[chain]?.[hook] ??
      (await new EvmHookReader(this.multiProvider, chain).deriveHookConfig(
        hook,
      ));

    if (this.hookCache) {
      this.hookCache[chain] ??= {};
      this.hookCache[chain][hook] = config;
    }

    return config;
  }

  async getIsmConfig(
    chain: ChainName,
    ism: Address,
  ): Promise<DerivedIsmConfigWithAddress> {
    const config =
      this.ismCache?.[chain]?.[ism] ??
      (await new EvmIsmReader(this.multiProvider, chain).deriveIsmConfig(ism));

    if (this.ismCache) {
      this.ismCache[chain] ??= {};
      this.ismCache[chain][ism] = config;
    }

    return config;
  }

  async getSenderHookConfig(
    message: DispatchedMessage,
  ): Promise<DerivedHookConfigWithAddress> {
    const originChain = this.core.getOrigin(message);
    const hook = await this.core.getSenderHookAddress(message);
    return this.getHookConfig(originChain, hook);
  }

  async getRecipientIsmConfig(
    message: DispatchedMessage,
  ): Promise<DerivedIsmConfigWithAddress> {
    const destinationChain = this.core.getDestination(message);
    const ism = await this.core.getRecipientIsmAddress(message);
    return this.getIsmConfig(destinationChain, ism);
  }

  async relayMessage(
    dispatchTx: TransactionReceipt,
    messageIndex = 0,
    message = HyperlaneCore.getDispatchedMessages(dispatchTx)[messageIndex],
  ): Promise<ethers.ContractReceipt> {
    const isDelivered = await this.core.isDelivered(message);
    if (isDelivered) {
      this.logger.debug(`Message ${message.id} already delivered`);
      return this.core.getProcessedReceipt(message);
    }

    this.logger.debug({ message }, `Simulating recipient message handling`);
    await this.core.estimateHandle(message);

    // parallelizable because configs are on different chains
    const [ism, hook] = await Promise.all([
      this.getRecipientIsmConfig(message),
      this.getSenderHookConfig(message),
    ]);
    this.logger.debug({ ism, hook }, `Retrieved ISM and hook configs`);

    const metadata = await pollAsync(
      () => this.metadataBuilder.build(message, { ism, hook, dispatchTx }),
      5 * 1000, // every 5 seconds
      12, // 12 attempts
    );

    this.logger.info({ message, metadata }, `Relaying message ${message.id}`);
    return this.core.process(message, metadata);
  }

  protected async hydrateDefaults(): Promise<void> {
    const defaults = await this.core.getDefaults();
    await promiseObjAll(
      objMap(defaults, async (chain, { ism, hook }) => {
        await this.getHookConfig(chain, hook);
        await this.getIsmConfig(chain, ism);
      }),
    );
  }

  async relay(): Promise<void> {
    await this.hydrateDefaults();

    this.core.onDispatch(async (message, event) => {
      const destination = message.parsed.destination;
      const chain = this.multiProvider.tryGetChainName(destination);
      if (!chain) {
        this.logger.warn(`Unknown destination ${destination}`);
        return;
      }

      this.logger.info(`Relaying message ${message.id} to chain ${chain}`);
      const dispatchReceipt = await event.getTransactionReceipt();
      await this.relayMessage(dispatchReceipt, undefined, message);
    });
  }
}
