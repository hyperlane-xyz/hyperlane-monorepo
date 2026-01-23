import { ethers, providers } from 'ethers';
import { Logger } from 'pino';
import { z } from 'zod';

import {
  ChainMap,
  ChainName,
  DispatchedMessage,
  EvmHookReader,
  EvmIsmReader,
  HookConfig,
  HyperlaneCore,
  IsmConfig,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ParsedMessage,
  WithAddress,
  assert,
  bytes32ToAddress,
  messageId,
  objMap,
  objMerge,
  parseMessage,
  promiseObjAll,
  sleep,
} from '@hyperlane-xyz/utils';

import { BaseMetadataBuilder } from '../metadata/builder.js';

type DerivedHookConfig = WithAddress<Exclude<HookConfig, Address>>;
type DerivedIsmConfig = WithAddress<Exclude<IsmConfig, Address>>;

/**
 * Callbacks for relayer events, useful for metrics and monitoring
 */
export interface RelayerEventCallbacks {
  onMessageRelayed?: (
    originChain: string,
    destinationChain: string,
    messageId: string,
    durationMs: number,
  ) => void;
  onMessageFailed?: (
    originChain: string,
    destinationChain: string,
    messageId: string,
    error: Error,
  ) => void;
  onMessageSkipped?: (
    originChain: string,
    destinationChain: string,
    messageId: string,
    reason: 'whitelist' | 'already_delivered',
  ) => void;
  onRetry?: (
    originChain: string,
    destinationChain: string,
    messageId: string,
    attempt: number,
  ) => void;
  onBacklogUpdate?: (size: number) => void;
}

const BacklogMessageSchema = z.object({
  attempts: z.number(),
  lastAttempt: z.number(),
  message: z.string(),
  dispatchTx: z.string(),
});

const MessageBacklogSchema = z.array(BacklogMessageSchema);

export const RelayerCacheSchema = z.object({
  hook: z.record(z.record(z.any())),
  ism: z.record(z.record(z.any())),
  backlog: MessageBacklogSchema,
});

export type RelayerCache = z.infer<typeof RelayerCacheSchema>;

type MessageWhitelist = ChainMap<Set<Address>>;

export function messageMatchesWhitelist(
  whitelist: MessageWhitelist,
  message: ParsedMessage,
): boolean {
  const originAddresses = whitelist[message.originChain ?? message.origin];
  if (!originAddresses) {
    return false;
  }

  const sender = bytes32ToAddress(message.sender);
  if (originAddresses.size !== 0 && !originAddresses.has(sender)) {
    return false;
  }

  const destinationAddresses =
    whitelist[message.destinationChain ?? message.destination];
  if (!destinationAddresses) {
    return false;
  }

  const recipient = bytes32ToAddress(message.recipient);
  if (destinationAddresses.size !== 0 && !destinationAddresses.has(recipient)) {
    return false;
  }

  return true;
}

export class HyperlaneRelayer {
  protected multiProvider: MultiProvider;
  protected metadataBuilder: BaseMetadataBuilder;
  protected readonly core: HyperlaneCore;
  protected readonly retryTimeout: number;

  protected readonly whitelist: ChainMap<Set<Address>> | undefined;
  protected readonly eventCallbacks: RelayerEventCallbacks;

  public backlog: RelayerCache['backlog'];
  public cache: RelayerCache | undefined;

  protected stopRelayingHandler: ((chains?: ChainName[]) => void) | undefined;

  public readonly logger: Logger;

  constructor({
    core,
    caching = true,
    retryTimeout = 1000,
    whitelist = undefined,
    eventCallbacks = {},
  }: {
    core: HyperlaneCore;
    caching?: boolean;
    retryTimeout?: number;
    whitelist?: ChainMap<Address[]>;
    eventCallbacks?: RelayerEventCallbacks;
  }) {
    this.core = core;
    this.retryTimeout = retryTimeout;
    this.logger = core.logger.child({ module: 'Relayer' });
    this.metadataBuilder = new BaseMetadataBuilder(core);
    this.multiProvider = core.multiProvider;
    this.eventCallbacks = eventCallbacks;
    if (whitelist) {
      this.whitelist = objMap(
        whitelist,
        (_chain, addresses) => new Set(addresses),
      );
    }

    this.backlog = [];
    if (caching) {
      this.cache = {
        hook: {},
        ism: {},
        backlog: [],
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

  async relayAll(
    dispatchTx: providers.TransactionReceipt,
    messages = HyperlaneCore.getDispatchedMessages(dispatchTx),
  ): Promise<ChainMap<ethers.ContractReceipt[]>> {
    const destinationMap: ChainMap<DispatchedMessage[]> = {};
    messages.forEach((message) => {
      destinationMap[message.parsed.destination] ??= [];
      destinationMap[message.parsed.destination].push(message);
    });

    return promiseObjAll(
      objMap(destinationMap, async (_destination, messages) => {
        const receipts: ethers.ContractReceipt[] = [];
        for (const message of messages) {
          try {
            const receipt = await this.relayMessage(
              dispatchTx,
              undefined,
              message,
            );
            receipts.push(receipt);
          } catch (e) {
            this.logger.error(`Failed to relay message ${message.id}, ${e}`);
          }
        }
        return receipts;
      }),
    );
  }

  async relayMessage(
    dispatchTx: providers.TransactionReceipt,
    messageIndex = 0,
    message = HyperlaneCore.getDispatchedMessages(dispatchTx)[messageIndex],
  ): Promise<ethers.ContractReceipt> {
    const originChain = this.core.getOrigin(message);
    const destinationChain = this.core.getDestination(message);

    if (this.whitelist) {
      message.parsed = {
        originChain,
        destinationChain,
        ...message.parsed,
      };
      if (!messageMatchesWhitelist(this.whitelist, message.parsed)) {
        this.eventCallbacks.onMessageSkipped?.(
          originChain,
          destinationChain,
          message.id,
          'whitelist',
        );
        throw new Error(`Message ${message.id} does not match whitelist`);
      }
    }

    this.logger.info(`Preparing to relay message ${message.id}`);

    const isDelivered = await this.core.isDelivered(message);
    if (isDelivered) {
      this.logger.info(`Message ${message.id} already delivered`);
      this.eventCallbacks.onMessageSkipped?.(
        originChain,
        destinationChain,
        message.id,
        'already_delivered',
      );
      return this.core.getProcessedReceipt(message);
    }

    this.logger.debug({ message }, `Simulating recipient message handling`);
    await this.core.estimateHandle(message);

    const [ism, hook] = await Promise.all([
      this.getRecipientIsmConfig(message),
      this.getSenderHookConfig(message),
    ]);
    this.logger.debug({ ism, hook }, `Retrieved ISM and hook configs`);

    const metadata = await this.metadataBuilder.build({
      message,
      ism,
      hook,
      dispatchTx,
    });

    const startTime = Date.now();
    this.logger.info(`Relaying message ${message.id}`);

    try {
      const receipt = await this.core.deliver(message, metadata);
      const durationMs = Date.now() - startTime;
      this.eventCallbacks.onMessageRelayed?.(
        originChain,
        destinationChain,
        message.id,
        durationMs,
      );
      return receipt;
    } catch (error) {
      this.eventCallbacks.onMessageFailed?.(
        originChain,
        destinationChain,
        message.id,
        error as Error,
      );
      throw error;
    }
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

  protected async flushBacklog(): Promise<void> {
    while (this.stopRelayingHandler) {
      this.eventCallbacks.onBacklogUpdate?.(this.backlog.length);

      const backlogMsg = this.backlog.shift();

      if (!backlogMsg) {
        this.logger.trace('Backlog empty, waiting 1s');
        await sleep(1000);
        continue;
      }

      const backoffTime =
        backlogMsg.lastAttempt + backlogMsg.attempts * this.retryTimeout;
      if (Date.now() < backoffTime) {
        this.backlog.push(backlogMsg);
        continue;
      }

      const { message, dispatchTx, attempts } = backlogMsg;
      const id = messageId(message);
      const parsed = parseMessage(message);
      const dispatchMsg = { id, message, parsed };
      const originChain =
        this.multiProvider.tryGetChainName(parsed.origin) ??
        String(parsed.origin);
      const destinationChain =
        this.multiProvider.tryGetChainName(parsed.destination) ??
        String(parsed.destination);

      try {
        const dispatchReceipt = await this.multiProvider
          .getProvider(parsed.origin)
          .getTransactionReceipt(dispatchTx);

        await this.relayMessage(dispatchReceipt, undefined, dispatchMsg);
      } catch {
        const newAttempts = attempts + 1;
        this.logger.error(
          `Failed to relay message ${id} (attempt #${newAttempts})`,
        );
        this.eventCallbacks.onRetry?.(
          originChain,
          destinationChain,
          id,
          newAttempts,
        );
        this.backlog.push({
          ...backlogMsg,
          attempts: newAttempts,
          lastAttempt: Date.now(),
        });
      }
    }
  }

  protected whitelistChains(): string[] | undefined {
    return this.whitelist ? Object.keys(this.whitelist) : undefined;
  }

  start(): void {
    assert(!this.stopRelayingHandler, 'Relayer already started');

    this.backlog = this.cache?.backlog ?? [];

    const { removeHandler } = this.core.onDispatch(async (message, event) => {
      if (
        this.whitelist &&
        !messageMatchesWhitelist(this.whitelist, message.parsed)
      ) {
        this.logger.debug(
          { message, whitelist: this.whitelist },
          `Skipping message ${message.id} not matching whitelist`,
        );
        return;
      }

      this.backlog.push({
        attempts: 0,
        lastAttempt: Date.now(),
        message: message.message,
        dispatchTx: event.transactionHash,
      });
    }, this.whitelistChains());

    this.stopRelayingHandler = removeHandler;

    void this.flushBacklog();
  }

  stop(): void {
    assert(this.stopRelayingHandler, 'Relayer not started');
    this.stopRelayingHandler(this.whitelistChains());
    this.stopRelayingHandler = undefined;

    if (this.cache) {
      this.cache.backlog = this.backlog;
    }
  }
}
