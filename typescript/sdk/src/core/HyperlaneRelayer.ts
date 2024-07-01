import { TransactionReceipt } from '@ethersproject/providers';
import { ethers } from 'ethers';
import { Logger } from 'pino';
import { z } from 'zod';

import { AbstractMessageIdAuthorizedIsm__factory } from '@hyperlane-xyz/core';
import {
  Address,
  assert,
  bytes32ToAddress,
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
import { IsmType } from '../ism/types.js';
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
  private multiProvider: MultiProvider;
  private metadataBuilder: BaseMetadataBuilder;

  public cache: RelayerCache | undefined;

  private stopRelayingHandler: ((chains?: ChainName[]) => void) | undefined;

  public readonly logger: Logger;

  constructor(protected readonly core: HyperlaneCore, caching = true) {
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
  ): Promise<DerivedHookConfig> {
    const config = (this.cache?.hook[chain]?.[hook] ??
      (await new EvmHookReader(this.multiProvider, chain).deriveHookConfig(
        hook,
      ))) as DerivedHookConfig | undefined;

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
  ): Promise<DerivedIsmConfig> {
    const config = (this.cache?.ism[chain]?.[ism] ??
      (await new EvmIsmReader(this.multiProvider, chain).deriveIsmConfig(
        ism,
      ))) as DerivedIsmConfig | undefined;

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
    customHook?: Address,
  ): Promise<DerivedHookConfig> {
    const originChain = this.core.getOrigin(message);
    const hook = customHook ?? (await this.core.getSenderHookAddress(message));
    return this.getHookConfig(originChain, hook);
  }

  async getRecipientIsmConfig(
    message: DispatchedMessage,
  ): Promise<{ config: DerivedIsmConfig; authorizedHook?: Address }> {
    const destinationChain = this.core.getDestination(message);
    const ism = await this.core.getRecipientIsmAddress(message);
    const config = await this.getIsmConfig(destinationChain, ism);
    let authorizedHook: Address | undefined;
    if (config.type === IsmType.ARB_L2_TO_L1) {
      authorizedHook = bytes32ToAddress(
        await AbstractMessageIdAuthorizedIsm__factory.connect(
          config.address,
          this.multiProvider.getProvider(destinationChain),
        ).authorizedHook(),
      );
      if (authorizedHook === ethers.constants.AddressZero) {
        authorizedHook = undefined;
      }
    }
    return {
      config,
      authorizedHook,
    };
  }

  async relayMessage(
    dispatchTx: TransactionReceipt,
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

    const { config: ism, authorizedHook } = await this.getRecipientIsmConfig(
      message,
    );
    const hook = await this.getSenderHookConfig(message, authorizedHook);
    this.logger.debug({ ism, hook }, `Retrieved ISM and hook configs`);

    const metadata = await pollAsync(
      () => this.metadataBuilder.build({ message, ism, hook, dispatchTx }),
      5 * 1000, // every 5 seconds
      1, // 1 attempts
    );

    this.logger.info({ message, metadata }, `Relaying message ${message.id}`);
    return this.core.deliver(message, metadata);
  }

  async relayMessages(
    dispatchTx: TransactionReceipt,
  ): Promise<ethers.ContractReceipt[]> {
    const messages = HyperlaneCore.getDispatchedMessages(dispatchTx);
    return Promise.all(
      messages.map((message, index) =>
        this.relayMessage(dispatchTx, index, message),
      ),
    );
  }

  async relayMessageId(
    originChain: ChainName,
    messageId: string,
  ): Promise<ethers.ContractReceipt> {
    const dispatchTx = await this.core.getDispatchTx(originChain, messageId);
    return this.relayMessage(dispatchTx);
  }

  hydrate(cache: RelayerCache): void {
    assert(this.cache, 'Caching not enabled');
    this.cache = objMerge(this.cache, cache);
  }

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

  start(chains = this.multiProvider.getKnownChainNames()): void {
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
      await this.relayMessage(dispatchReceipt, undefined, message);
    }, chains);

    this.stopRelayingHandler = removeHandler;
  }

  stop(chains = this.multiProvider.getKnownChainNames()): void {
    assert(this.stopRelayingHandler, 'Relayer not started');
    this.stopRelayingHandler(chains);
    this.stopRelayingHandler = undefined;
  }
}
