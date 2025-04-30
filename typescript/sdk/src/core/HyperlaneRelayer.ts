import { ethers, providers } from 'ethers';
import { Logger } from 'pino';
import { z } from 'zod';

import {
  Address,
  ParsedMessage,
  assert,
  bytes32ToAddress,
  messageId,
  objMap,
  objMerge,
  parseMessage,
  promiseObjAll,
  sleep,
} from '@hyperlane-xyz/utils';

import { EvmHookReader } from '../hook/EvmHookReader.js';
import { DerivedHookConfig, HookConfigSchema } from '../hook/types.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { BaseMetadataBuilder } from '../ism/metadata/builder.js';
import { DerivedIsmConfig, IsmConfigSchema } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';

import { HyperlaneCore } from './HyperlaneCore.js';
import { DispatchedMessage } from './types.js';

const WithAddressSchema = z.object({
  address: z.string(),
});

const DerivedHookConfigWithAddressSchema =
  HookConfigSchema.and(WithAddressSchema);
const DerivedIsmConfigWithAddressSchema =
  IsmConfigSchema.and(WithAddressSchema);

const BacklogMessageSchema = z.object({
  attempts: z.number(),
  lastAttempt: z.number(),
  message: z.string(),
  dispatchTx: z.string(),
});

const MessageBacklogSchema = z.array(BacklogMessageSchema);

export const RelayerCacheSchema = z.object({
  hook: z.record(z.record(DerivedHookConfigWithAddressSchema)),
  ism: z.record(z.record(DerivedIsmConfigWithAddressSchema)),
  backlog: MessageBacklogSchema,
});

type RelayerCache = z.infer<typeof RelayerCacheSchema>;

type MessageWhitelist = ChainMap<Set<Address>>;

// message must have origin and destination chains in the whitelist
// if whitelist has non-empty address set for chain, message must have sender and recipient in the set
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

interface DerivedRelayerCache extends RelayerCache {
  hook: Record<string, Record<string, DerivedHookConfig>>;
}

export class HyperlaneRelayer {
  protected multiProvider: MultiProvider;
  protected metadataBuilder: BaseMetadataBuilder;
  protected readonly core: HyperlaneCore;
  protected readonly retryTimeout: number;

  protected readonly whitelist: ChainMap<Set<Address>> | undefined;

  public backlog: RelayerCache['backlog'];
  public cache: DerivedRelayerCache | undefined;

  protected stopRelayingHandler: ((chains?: ChainName[]) => void) | undefined;

  public readonly logger: Logger;

  constructor({
    core,
    caching = true,
    retryTimeout = 1000,
    whitelist = undefined,
  }: {
    core: HyperlaneCore;
    caching?: boolean;
    retryTimeout?: number;
    whitelist?: ChainMap<Address[]>;
  }) {
    this.core = core;
    this.retryTimeout = retryTimeout;
    this.logger = core.logger.child({ module: 'Relayer' });
    this.metadataBuilder = new BaseMetadataBuilder(core);
    this.multiProvider = core.multiProvider;
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
      config = this.cache.hook[chain][hook];
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

    // parallelize relaying to different destinations
    return promiseObjAll(
      objMap(destinationMap, async (_destination, messages) => {
        const receipts: ethers.ContractReceipt[] = [];
        // serially relay messages to the same destination
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
    if (this.whitelist) {
      // add human readable names for use in whitelist checks
      message.parsed = {
        originChain: this.core.getOrigin(message),
        destinationChain: this.core.getDestination(message),
        ...message.parsed,
      };
      assert(
        messageMatchesWhitelist(this.whitelist, message.parsed),
        `Message ${message.id} does not match whitelist`,
      );
    }

    this.logger.info(`Preparing to relay message ${message.id}`);

    const isDelivered = await this.core.isDelivered(message);
    if (isDelivered) {
      this.logger.info(`Message ${message.id} already delivered`);
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

    const metadata = await this.metadataBuilder.build({
      message,
      ism,
      hook,
      dispatchTx,
    });

    this.logger.info(`Relaying message ${message.id}`);
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

  protected async flushBacklog(): Promise<void> {
    while (this.stopRelayingHandler) {
      const backlogMsg = this.backlog.shift();

      if (!backlogMsg) {
        this.logger.trace('Backlog empty, waiting 1s');
        await sleep(1000);
        continue;
      }

      // linear backoff (attempts * retryTimeout)
      if (
        Date.now() <
        backlogMsg.lastAttempt + backlogMsg.attempts * this.retryTimeout
      ) {
        this.backlog.push(backlogMsg);
        continue;
      }

      const { message, dispatchTx, attempts } = backlogMsg;
      const id = messageId(message);
      const parsed = parseMessage(message);
      const dispatchMsg = { id, message, parsed };

      try {
        const dispatchReceipt = await this.multiProvider
          .getProvider(parsed.origin)
          .getTransactionReceipt(dispatchTx);

        // TODO: handle batching
        await this.relayMessage(dispatchReceipt, undefined, dispatchMsg);
      } catch {
        this.logger.error(
          `Failed to relay message ${id} (attempt #${attempts + 1})`,
        );
        this.backlog.push({
          ...backlogMsg,
          attempts: attempts + 1,
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

    // start flushing backlog
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
