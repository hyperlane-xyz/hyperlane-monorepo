import { ethers, providers } from 'ethers';
import { Logger } from 'pino';
import { z } from 'zod';

import {
  Address,
  assert,
  objMap,
  objMerge,
  pollAsync,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { DerivedHookConfig, EvmHookReader } from '../hook/EvmHookReader.js';
import { HookConfigSchema } from '../hook/schemas.js';
import { DerivedIsmConfig, EvmIsmReader } from '../ism/EvmIsmReader.js';
import { BaseMetadataBuilder } from '../ism/metadata/builder.js';
import { IsmConfigSchema } from '../ism/schemas.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import { HyperlaneCore } from './HyperlaneCore.js';
import { DispatchedMessage } from './types.js';

const WithAddressSchema = z.object({
  address: z.string(),
});

const DerivedHookConfigWithAddressSchema =
  HookConfigSchema.and(WithAddressSchema);
const DerivedIsmConfigWithAddressSchema =
  IsmConfigSchema.and(WithAddressSchema);

export const RelayerCacheSchema = z.object({
  hook: z.record(z.record(DerivedHookConfigWithAddressSchema)),
  ism: z.record(z.record(DerivedIsmConfigWithAddressSchema)),
});

type RelayerCache = z.infer<typeof RelayerCacheSchema>;

export class HyperlaneRelayer {
  protected multiProvider: MultiProvider;
  protected metadataBuilder: BaseMetadataBuilder;
  protected readonly core: HyperlaneCore;
  protected readonly retryTimeout: number;

  public cache: RelayerCache | undefined;

  protected stopRelayingHandler: ((chains?: ChainName[]) => void) | undefined;

  public readonly logger: Logger;

  constructor({
    core,
    caching = true,
    retryTimeout = 5 * 1000,
  }: {
    core: HyperlaneCore;
    caching?: boolean;
    retryTimeout?: number;
  }) {
    this.core = core;
    this.retryTimeout = retryTimeout;
    this.logger = core.logger.child({ module: 'Relayer' });
    this.metadataBuilder = new BaseMetadataBuilder(core);
    this.multiProvider = core.multiProvider;
    if (caching) {
      this.cache = {
        hook: {},
        ism: {},
      };
    }
  }

  async getHookConfig(
    chain: ChainName,
    hook: Address,
    messageContext?: DispatchedMessage,
  ): Promise<DerivedHookConfig> {
    let config: DerivedHookConfig | undefined;
    if (this.cache?.hook[chain]?.[hook]) {
      config = this.cache.hook[chain][hook] as DerivedHookConfig | undefined;
    } else {
      const evmHookReader = new EvmHookReader(
        this.multiProvider,
        chain,
        undefined,
        messageContext,
      );
      config = await evmHookReader.deriveHookConfig(hook);
    }

    if (!config) {
      throw new Error(`Hook config not found for ${hook}`);
    }
    if (this.cache) {
      this.cache.hook[chain] ??= {};
      this.cache.hook[chain][hook] = config;
    }

    return config;
  }

  async getIsmConfig(
    chain: ChainName,
    ism: Address,
    messageContext?: DispatchedMessage,
  ): Promise<DerivedIsmConfig> {
    let config: DerivedIsmConfig | undefined;
    if (this.cache?.ism[chain]?.[ism]) {
      config = this.cache.ism[chain][ism] as DerivedIsmConfig | undefined;
    } else {
      const evmIsmReader = new EvmIsmReader(
        this.multiProvider,
        chain,
        undefined,
        messageContext,
      );
      config = await evmIsmReader.deriveIsmConfig(ism);
    }

    if (!config) {
      throw new Error(`ISM config not found for ${ism}`);
    }

    if (this.cache) {
      this.cache.ism[chain] ??= {};
      this.cache.ism[chain][ism] = config;
    }

    return config;
  }

  async getSenderHookConfig(
    message: DispatchedMessage,
  ): Promise<DerivedHookConfig> {
    const originChain = this.core.getOrigin(message);
    const hook = await this.core.getSenderHookAddress(message);
    return this.getHookConfig(originChain, hook, message);
  }

  async getRecipientIsmConfig(
    message: DispatchedMessage,
  ): Promise<DerivedIsmConfig> {
    const destinationChain = this.core.getDestination(message);
    const ism = await this.core.getRecipientIsmAddress(message);
    return this.getIsmConfig(destinationChain, ism, message);
  }

  async relayMessage(
    dispatchTx: providers.TransactionReceipt,
    messageIndex = 0,
    message = HyperlaneCore.getDispatchedMessages(dispatchTx)[messageIndex],
  ): Promise<ethers.ContractReceipt> {
    this.logger.info(`Preparing to relay message ${message.id}`);

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

    const blockTime = this.multiProvider.getChainMetadata(
      message.parsed.destination,
    ).blocks?.estimateBlockTime;
    const waitTime = blockTime ? blockTime * 2 : this.retryTimeout;

    const metadata = await pollAsync(
      () => this.metadataBuilder.build({ message, ism, hook, dispatchTx }),
      waitTime,
      12, // 12 attempts
    );

    this.logger.info({ message, metadata }, `Relaying message ${message.id}`);
    return this.core.deliver(message, metadata);
  }

  hydrate(cache: RelayerCache): void {
    assert(this.cache, 'Caching not enabled');
    this.cache = objMerge(this.cache, cache);
  }

  // fill cache with default ISM and hook configs for quicker relaying (optional)
  async hydrateDefaults(): Promise<void> {
    assert(this.cache, 'Caching not enabled');

    const defaults = await this.core.getDefaults();
    await promiseObjAll(
      objMap(defaults, async (chain, { ism, hook }) => {
        this.logger.debug(
          `Hydrating ${chain} cache with default ISM and hook configs`,
        );
        await this.getHookConfig(chain, hook);
        await this.getIsmConfig(chain, ism);
      }),
    );
  }

  start(chains = this.core.chains()): void {
    assert(!this.stopRelayingHandler, 'Relayer already started');

    const { removeHandler } = this.core.onDispatch(async (message, event) => {
      const destination = message.parsed.destination;
      const chain = this.multiProvider.tryGetChainName(destination);
      if (!chain) {
        this.logger.warn(`Unknown destination ${destination}`);
        return;
      }

      if (!chains.includes(chain)) {
        this.logger.info(`Skipping message to chain ${chain}`);
        return;
      }

      const dispatchReceipt = await event.getTransactionReceipt();
      const processReceipt = await this.relayMessage(
        dispatchReceipt,
        undefined,
        message,
      );

      this.logger.info(
        `Message ${message.id} was processed in ${
          this.multiProvider.tryGetExplorerTxUrl(destination, {
            hash: processReceipt.transactionHash,
          }) ?? 'tx ' + processReceipt.transactionHash
        }`,
      );
    }, chains);

    this.stopRelayingHandler = removeHandler;
  }

  stop(chains = this.core.chains()): void {
    assert(this.stopRelayingHandler, 'Relayer not started');
    this.stopRelayingHandler(chains);
    this.stopRelayingHandler = undefined;
  }
}
