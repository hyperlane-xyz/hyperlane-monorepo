import type { TransactionReceipt as ViemTxReceipt } from 'viem';
import { zeroAddress } from 'viem';

import {
  IMessageRecipient,
  IMessageRecipient__factory,
  MailboxClient__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  AddressBytes32,
  ProtocolType,
  addBufferToGasLimit,
  addressToBytes32,
  assert,
  bytes32ToAddress,
  isZeroishAddress,
  messageId,
  objFilter,
  objMap,
  parseMessage,
  pollAsync,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../app/HyperlaneApp.js';
import { appFromAddressesMapHelper } from '../contracts/contracts.js';
import {
  HyperlaneFactories,
  HyperlaneAddressesMap,
  HyperlaneContracts,
} from '../contracts/types.js';
import { EvmHookReader } from '../hook/EvmHookReader.js';
import { DerivedHookConfig } from '../hook/types.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { DerivedIsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import type { EvmTransactionResponseLike } from '../providers/evmTypes.js';
import { RouterConfig } from '../router/types.js';
import { ChainMap, ChainName, OwnableConfig } from '../types.js';
import { estimateHandleGasForRecipient } from '../utils/gas.js';
import { findMatchingLogEvents } from '../utils/logUtils.js';

import { CoreFactories, coreFactories } from './contracts.js';
import { DispatchEvent } from './events.js';
import { DispatchedMessage } from './types.js';

// If no metadata is provided, ensure we provide a default of 0x0001.
// We set to 0x0001 instead of 0x0 to ensure it does not break on zksync.
const DEFAULT_METADATA = '0x0001';
type EvmTxReceipt = Awaited<ReturnType<MultiProvider['handleTx']>>;
type EventLike = {
  args?: unknown;
  blockNumber?: number | bigint;
  block_number?: number | bigint;
  getTransactionReceipt?: () => Promise<unknown>;
  getTransaction?: () => Promise<EvmTransactionResponseLike>;
  log?: { blockNumber?: number | bigint; transactionHash?: string };
  transaction?: { hash?: string };
  transactionHash?: string;
};

type MailboxEventApi = {
  on?: (filter: unknown, listener: (...args: unknown[]) => unknown) => void;
  off?: (filter: unknown, listener: (...args: unknown[]) => unknown) => void;
  once?: (
    filter: unknown,
    listener: (emittedId: string, event: EventLike) => void,
  ) => void;
  removeAllListeners?: (eventName?: string) => void;
};

function asEventLike(value: unknown): EventLike {
  return typeof value === 'object' && value !== null
    ? (value as EventLike)
    : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function eventTxHash(event: EventLike): string | undefined {
  return (
    event.transactionHash ??
    event.log?.transactionHash ??
    event.transaction?.hash
  );
}

function eventBlockNumber(event: EventLike): number | undefined {
  const blockNumberSnakeCase = event.block_number;
  const block =
    event.blockNumber ?? event.log?.blockNumber ?? blockNumberSnakeCase;
  if (typeof block === 'number') return block;
  if (typeof block === 'bigint') return Number(block);
  return undefined;
}

function parseDispatchMessage(
  event: EventLike,
  positionalMessage?: unknown,
): string | undefined {
  if (typeof positionalMessage === 'string') return positionalMessage;

  const args = event.args;
  if (!args) return undefined;

  if (Array.isArray(args)) {
    const message = args[3];
    return typeof message === 'string' ? message : undefined;
  }

  const argsObj = asRecord(args);
  if (argsObj) {
    const message = argsObj.message;
    return typeof message === 'string' ? message : undefined;
  }

  return undefined;
}

function getMailboxEventApi(mailbox: unknown): MailboxEventApi {
  const record = asRecord(mailbox);
  return {
    on:
      typeof record?.on === 'function'
        ? (record.on as MailboxEventApi['on'])
        : undefined,
    off:
      typeof record?.off === 'function'
        ? (record.off as MailboxEventApi['off'])
        : undefined,
    once:
      typeof record?.once === 'function'
        ? (record.once as MailboxEventApi['once'])
        : undefined,
    removeAllListeners:
      typeof record?.removeAllListeners === 'function'
        ? (record.removeAllListeners as MailboxEventApi['removeAllListeners'])
        : undefined,
  };
}

function toEvmTxReceipt(receipt: unknown, context: string): EvmTxReceipt {
  assert(
    typeof receipt === 'object' && receipt !== null,
    `Missing transaction receipt for ${context}`,
  );
  return receipt as EvmTxReceipt;
}

function toDispatchEvent(event: EventLike): DispatchEvent {
  const rawArgs = asRecord(event.args);
  const message = rawArgs?.message;
  const args =
    typeof message === 'string'
      ? {
          message,
        }
      : undefined;

  return {
    args,
    blockNumber: eventBlockNumber(event),
    transactionHash: eventTxHash(event),
  };
}

export class HyperlaneCore extends HyperlaneApp<CoreFactories> {
  static fromAddressesMap<F extends HyperlaneFactories>(
    addressesMap: HyperlaneAddressesMap<F>,
    multiProvider: MultiProvider,
  ): HyperlaneCore {
    const helper = appFromAddressesMapHelper(
      addressesMap as HyperlaneAddressesMap<CoreFactories>,
      coreFactories,
      multiProvider,
    );
    return new HyperlaneCore(helper.contractsMap, helper.multiProvider);
  }

  getRouterConfig = (
    owners: Address | ChainMap<OwnableConfig>,
  ): ChainMap<RouterConfig> => {
    // filter for EVM chains
    const evmContractsMap = objFilter(
      this.contractsMap,
      (chainName, _): _ is HyperlaneContracts<CoreFactories> =>
        this.multiProvider.getProtocol(chainName) === ProtocolType.Ethereum,
    );

    // get config
    const config = objMap(
      evmContractsMap,
      (chain, contracts): RouterConfig => ({
        mailbox: contracts.mailbox.address,
        owner: typeof owners === 'string' ? owners : owners[chain].owner,
        ownerOverrides:
          typeof owners === 'string' ? undefined : owners[chain].ownerOverrides,
      }),
    );

    return config;
  };

  quoteGasPayment = (
    origin: ChainName,
    destination: ChainName,
    recipient: AddressBytes32,
    body: string,
    metadata?: string,
    hook?: Address,
  ) => {
    const destinationId = this.multiProvider.getDomainId(destination);
    return this.contractsMap[origin].mailbox[
      'quoteDispatch(uint32,bytes32,bytes,bytes,address)'
    ](
      destinationId,
      recipient,
      body,
      metadata || DEFAULT_METADATA,
      hook || zeroAddress,
    );
  };

  getDestination(message: DispatchedMessage): ChainName {
    return this.multiProvider.getChainName(message.parsed.destination);
  }

  getOrigin(message: DispatchedMessage): ChainName {
    return this.multiProvider.getChainName(message.parsed.origin);
  }

  async getRecipientIsmAddress(message: DispatchedMessage): Promise<Address> {
    const destinationMailbox = this.contractsMap[this.getDestination(message)];
    const ethAddress = bytes32ToAddress(message.parsed.recipient);
    return destinationMailbox.mailbox.recipientIsm(ethAddress);
  }

  async getHookAddress(message: DispatchedMessage): Promise<Address> {
    const destinationMailbox = this.contractsMap[this.getOrigin(message)];
    /* TODO: requiredHook() account for here: https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/3693 */
    return destinationMailbox.mailbox.defaultHook();
  }

  async getRecipientIsmConfig(
    message: DispatchedMessage,
  ): Promise<DerivedIsmConfig> {
    const destinationChain = this.getDestination(message);
    const ismReader = new EvmIsmReader(this.multiProvider, destinationChain);
    const address = await this.getRecipientIsmAddress(message);
    return ismReader.deriveIsmConfig(address);
  }

  async getHookConfig(message: DispatchedMessage): Promise<DerivedHookConfig> {
    const originChain = this.getOrigin(message);
    const hookReader = new EvmHookReader(this.multiProvider, originChain);
    const address = await this.getHookAddress(message);
    return hookReader.deriveHookConfig(address);
  }

  async sendMessage(
    origin: ChainName,
    destination: ChainName,
    recipient: Address,
    body: string,
    hook?: Address,
    metadata?: string,
  ): Promise<{ dispatchTx: EvmTxReceipt; message: DispatchedMessage }> {
    const mailbox = this.getContracts(origin).mailbox;
    const destinationDomain = this.multiProvider.getDomainId(destination);
    const recipientBytes32 = addressToBytes32(recipient);
    const quote = await this.quoteGasPayment(
      origin,
      destination,
      recipientBytes32,
      body,
      metadata,
      hook,
    );

    const dispatchParams = [
      destinationDomain,
      recipientBytes32,
      body,
      metadata || DEFAULT_METADATA,
      hook || zeroAddress,
    ] as const;

    const estimateGas = await mailbox.estimateGas[
      'dispatch(uint32,bytes32,bytes,bytes,address)'
    ](...dispatchParams, { value: quote });

    const dispatchTx = await this.multiProvider.handleTx(
      origin,
      mailbox['dispatch(uint32,bytes32,bytes,bytes,address)'](
        ...dispatchParams,
        {
          ...this.multiProvider.getTransactionOverrides(origin),
          value: quote,
          gasLimit: addBufferToGasLimit(estimateGas),
        },
      ) as Promise<EvmTransactionResponseLike>,
    );

    return {
      dispatchTx,
      message: this.getDispatchedMessages(dispatchTx)[0],
    };
  }

  onDispatch(
    handler: (
      message: DispatchedMessage,
      event: DispatchEvent,
    ) => Promise<void>,
    chains = Object.keys(this.contractsMap),
  ): {
    removeHandler: (chains?: ChainName[]) => void;
  } {
    const teardownByChain: Partial<Record<ChainName, () => void>> = {};

    chains.map((originChain) => {
      const mailbox = this.contractsMap[originChain].mailbox;
      this.logger.debug(`Listening for dispatch on ${originChain}`);
      const filter = {
        address: mailbox.address,
        eventName: 'Dispatch',
        args: [] as const,
      };
      const mailboxWithEvents = getMailboxEventApi(mailbox);

      const emitDispatch = async (event: EventLike, message?: unknown) => {
        const parsedMessage = parseDispatchMessage(event, message);
        if (!parsedMessage) {
          this.logger.debug(
            `Skipping dispatch event on ${originChain}: missing message payload`,
          );
          return;
        }

        const dispatched = HyperlaneCore.parseDispatchedMessage(parsedMessage);
        dispatched.parsed.originChain = this.getOrigin(dispatched);
        dispatched.parsed.destinationChain = this.getDestination(dispatched);

        this.logger.info(
          `Observed message ${dispatched.id} on ${originChain} to ${dispatched.parsed.destinationChain}`,
        );
        await handler(dispatched, toDispatchEvent(event));
      };

      if (typeof mailboxWithEvents.on === 'function') {
        const listener = (...args: unknown[]) => {
          const message = args[3];
          const event = asEventLike(args[args.length - 1]);
          void emitDispatch(event, message);
        };
        mailboxWithEvents.on(filter, listener);
        teardownByChain[originChain] = () => {
          if (typeof mailboxWithEvents.off === 'function') {
            mailboxWithEvents.off(filter, listener);
          } else if (
            typeof mailboxWithEvents.removeAllListeners === 'function'
          ) {
            mailboxWithEvents.removeAllListeners('Dispatch');
          }
        };
        return;
      }

      // Viem contract proxies don't expose event emitters, so poll for new Dispatch logs.
      let stopped = false;
      let polling = false;
      let interval: ReturnType<typeof setInterval> | undefined;
      let lastSeenBlock = 0;

      const poll = async () => {
        if (stopped || polling) return;
        polling = true;

        try {
          const { toBlock: latestBlock } =
            await this.multiProvider.getLatestBlockRange(originChain, 1);
          if (latestBlock <= lastSeenBlock) return;

          const events = (
            await mailbox.queryFilter(filter, lastSeenBlock + 1, latestBlock)
          ).map(asEventLike);

          for (const event of events) {
            await emitDispatch(event);
            const block = eventBlockNumber(event);
            if (block !== undefined) {
              lastSeenBlock = Math.max(lastSeenBlock, block);
            }
          }

          lastSeenBlock = Math.max(lastSeenBlock, latestBlock);
        } catch (error) {
          this.logger.debug(
            `Dispatch polling failed on ${originChain}, will retry on next interval`,
          );
          this.logger.trace({ error });
        } finally {
          polling = false;
        }
      };

      teardownByChain[originChain] = () => {
        stopped = true;
        if (interval) {
          clearInterval(interval);
          interval = undefined;
        }
      };

      void (async () => {
        try {
          const { toBlock } = await this.multiProvider.getLatestBlockRange(
            originChain,
            1,
          );
          // Include one block of startup lookback so dispatches emitted while
          // the listener boots are still captured on first poll.
          lastSeenBlock = Math.max(0, toBlock - 1);
        } catch {
          lastSeenBlock = 0;
        }

        if (stopped) return;
        interval = setInterval(() => {
          void poll();
        }, 1000);
      })();
    });

    return {
      removeHandler: (removeChains) => {
        (removeChains ?? chains).map((originChain) => {
          teardownByChain[originChain]?.();
          this.logger.debug(`Stopped listening for dispatch on ${originChain}`);
        });
      },
    };
  }

  getDefaults(): Promise<ChainMap<{ ism: Address; hook: Address }>> {
    return promiseObjAll(
      objMap(this.contractsMap, async (_, contracts) => ({
        ism: await contracts.mailbox.defaultIsm(),
        hook: await contracts.mailbox.defaultHook(),
      })),
    );
  }

  getIsm(
    destinationChain: ChainName,
    recipientAddress: Address,
  ): Promise<Address> {
    const destinationMailbox = this.contractsMap[destinationChain];
    return destinationMailbox.mailbox.recipientIsm(recipientAddress);
  }

  protected getRecipient(message: DispatchedMessage): IMessageRecipient {
    return IMessageRecipient__factory.connect(
      bytes32ToAddress(message.parsed.recipient),
      this.multiProvider.getProvider(this.getDestination(message)),
    );
  }

  async estimateHandle(message: DispatchedMessage): Promise<string> {
    // This estimation overrides transaction.from which requires a funded signer
    // on ZkSync-based chains. We catch estimation failures and return '0' to
    // allow the caller to handle gas estimation differently.
    return this.estimateHandleGas({
      destination: this.getDestination(message),
      recipient: bytes32ToAddress(message.parsed.recipient),
      origin: message.parsed.origin,
      sender: message.parsed.sender,
      body: message.parsed.body,
    });
  }

  /**
   * Estimates gas for calling handle() on a recipient contract.
   *
   * This is a flexible utility that accepts minimal parameters (destination,
   * recipient, origin, sender, body) instead of requiring a full DispatchedMessage.
   * Use this when you have message components but not a complete DispatchedMessage object.
   *
   * @param params - Object containing:
   *   - destination: The destination chain name
   *   - recipient: The recipient contract address (or any IMessageRecipient implementation like ICA router)
   *   - origin: The origin domain ID
   *   - sender: The sender address (as bytes32 string)
   *   - body: The message body (as hex string)
   *   - mailbox: Optional mailbox address override (defaults to chain's configured mailbox)
   * @returns Gas estimate as a string, or '0' if estimation fails
   */
  async estimateHandleGas(params: {
    destination: ChainName;
    recipient: Address;
    origin: number;
    sender: string;
    body: string;
    mailbox?: Address;
  }): Promise<string> {
    try {
      const provider = this.multiProvider.getProvider(params.destination);
      const mailbox =
        params.mailbox ?? this.getAddresses(params.destination).mailbox;
      const recipientContract = IMessageRecipient__factory.connect(
        params.recipient,
        provider,
      );

      const gasEstimate = await estimateHandleGasForRecipient({
        recipient: recipientContract,
        origin: params.origin,
        sender: params.sender,
        body: params.body,
        mailbox,
      });

      return gasEstimate?.toString() ?? '0';
    } catch {
      return '0';
    }
  }

  deliver(
    message: DispatchedMessage,
    ismMetadata: string,
  ): Promise<EvmTxReceipt> {
    const destinationChain = this.getDestination(message);
    const txOverrides =
      this.multiProvider.getTransactionOverrides(destinationChain);
    return this.multiProvider.handleTx(
      destinationChain,
      this.getContracts(destinationChain).mailbox.process(
        ismMetadata,
        message.message,
        { ...txOverrides },
      ),
    );
  }

  async getHook(
    originChain: ChainName,
    senderAddress: Address,
  ): Promise<Address> {
    const provider = this.multiProvider.getProvider(originChain);
    try {
      const client = MailboxClient__factory.connect(senderAddress, provider);
      const hook = await client.hook();
      if (!isZeroishAddress(hook)) {
        return hook;
      }
    } catch (e) {
      this.logger.debug(`MailboxClient hook not found for ${senderAddress}`);
      this.logger.trace({ e });
    }

    const originMailbox = this.contractsMap[originChain].mailbox;
    return originMailbox.defaultHook();
  }

  isDelivered(message: DispatchedMessage): Promise<boolean> {
    const destinationChain = this.getDestination(message);
    return this.getContracts(destinationChain).mailbox.delivered(message.id);
  }

  async getSenderHookAddress(message: DispatchedMessage): Promise<Address> {
    const originChain = this.getOrigin(message);
    const senderAddress = bytes32ToAddress(message.parsed.sender);
    return this.getHook(originChain, senderAddress);
  }

  async getProcessedReceipt(message: DispatchedMessage): Promise<EvmTxReceipt> {
    const destinationChain = this.getDestination(message);
    const mailbox = this.getContracts(destinationChain).mailbox;

    const processedBlock = await mailbox.processedAt(message.id);
    const events = await mailbox.queryFilter(
      {
        address: mailbox.address,
        eventName: 'ProcessId',
        args: [message.id] as const,
      },
      processedBlock,
      processedBlock,
    );

    assert(
      events.length === 1,
      `Expected exactly one process event, got ${events.length}`,
    );
    const processedEvent = events[0];
    return this.getReceiptFromEvent(
      destinationChain,
      asEventLike(processedEvent),
      `process event for message ${message.id}`,
    );
  }

  protected waitForProcessReceipt(
    message: DispatchedMessage,
  ): Promise<EvmTxReceipt> {
    const id = messageId(message.message);
    const destinationChain = this.getDestination(message);
    const mailbox = this.contractsMap[destinationChain].mailbox;
    const filter = {
      address: mailbox.address,
      eventName: 'ProcessId',
      args: [id] as const,
    };

    const mailboxWithEvents = getMailboxEventApi(mailbox);

    if (typeof mailboxWithEvents.once === 'function') {
      return new Promise<EvmTxReceipt>((resolve, reject) => {
        mailboxWithEvents.once?.(
          filter,
          (emittedId: string, event: EventLike) => {
            if (id !== emittedId) {
              reject(`Expected message id ${id} but got ${emittedId}`);
              return;
            }

            if (typeof event.getTransaction === 'function') {
              resolve(
                this.multiProvider.handleTx(
                  destinationChain,
                  event.getTransaction(),
                ),
              );
              return;
            }

            this.getReceiptFromEvent(
              destinationChain,
              event,
              `process event for message ${id}`,
            )
              .then(resolve)
              .catch(reject);
          },
        );
      });
    }

    return (async () => {
      await this.waitForMessageIdProcessed(id, destinationChain, 1000, 120);
      return this.getProcessedReceipt(message);
    })();
  }

  async waitForMessageIdProcessed(
    messageId: string,
    destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<true> {
    await pollAsync(
      async () => {
        this.logger.debug(`Checking if message ${messageId} was processed`);
        const mailbox = this.contractsMap[destination].mailbox;
        const delivered = await mailbox.delivered(messageId);
        if (delivered) {
          this.logger.info(`Message ${messageId} was processed`);
          return true;
        } else {
          throw new Error(`Message ${messageId} not yet processed`);
        }
      },
      delayMs,
      maxAttempts,
    );
    return true;
  }

  waitForMessageProcessing(
    sourceTx: EvmTxReceipt | ViemTxReceipt,
  ): Promise<EvmTxReceipt[]> {
    const messages = HyperlaneCore.getDispatchedMessages(sourceTx);
    return Promise.all(messages.map((msg) => this.waitForProcessReceipt(msg)));
  }

  // TODO consider renaming this, all the waitForMessage* methods are confusing
  async waitForMessageProcessed(
    sourceTx: EvmTxReceipt | ViemTxReceipt,
    delay?: number,
    maxAttempts?: number,
  ): Promise<void> {
    const messages = HyperlaneCore.getDispatchedMessages(sourceTx);
    await Promise.all(
      messages.map((msg) =>
        this.waitForMessageIdProcessed(
          msg.id,
          this.getDestination(msg),
          delay,
          maxAttempts,
        ),
      ),
    );
    const txHash = HyperlaneCore.getTransactionHash(sourceTx);
    this.logger.info(`All messages processed for tx ${txHash}`);
  }

  // Redundant with static method but keeping for backwards compatibility
  getDispatchedMessages(
    sourceTx: EvmTxReceipt | ViemTxReceipt,
  ): DispatchedMessage[] {
    const messages = HyperlaneCore.getDispatchedMessages(sourceTx);
    return messages.map(({ parsed, ...other }) => {
      const originChain =
        this.multiProvider.tryGetChainName(parsed.origin) ?? undefined;
      const destinationChain =
        this.multiProvider.tryGetChainName(parsed.destination) ?? undefined;
      return {
        parsed: { ...parsed, originChain, destinationChain },
        ...other,
      };
    });
  }

  async getDispatchTx(
    originChain: ChainName,
    messageId: string,
    blockNumber?: number,
  ): Promise<EvmTxReceipt> {
    const mailbox = this.contractsMap[originChain].mailbox;
    const filter = {
      address: mailbox.address,
      eventName: 'DispatchId',
      args: [messageId] as const,
    };

    const { fromBlock, toBlock } = blockNumber
      ? { toBlock: blockNumber, fromBlock: blockNumber }
      : await this.multiProvider.getLatestBlockRange(originChain);

    const matching = await mailbox.queryFilter(filter, fromBlock, toBlock);
    if (matching.length === 0) {
      throw new Error(`No dispatch event found for message ${messageId}`);
    }

    assert(matching.length === 1, 'Multiple dispatch events found');
    const event = matching[0]; // only 1 event per message ID
    return this.getReceiptFromEvent(
      originChain,
      asEventLike(event),
      `dispatch event for message ${messageId}`,
    );
  }

  private async getReceiptFromEvent(
    chain: ChainName,
    event: EventLike,
    context: string,
  ): Promise<EvmTxReceipt> {
    if (typeof event.getTransactionReceipt === 'function') {
      const receipt = await event.getTransactionReceipt();
      return toEvmTxReceipt(receipt, context);
    }

    const txHash = eventTxHash(event);
    assert(txHash, `Missing transaction hash for ${context}`);
    const receipt = await this.multiProvider
      .getProvider(chain)
      .getTransactionReceipt(txHash);
    return toEvmTxReceipt(receipt, context);
  }

  static parseDispatchedMessage(message: string): DispatchedMessage {
    const parsed = parseMessage(message);
    const id = messageId(message);
    return { id, message, parsed };
  }

  static getDispatchedMessages(
    sourceTx: EvmTxReceipt | ViemTxReceipt,
  ): DispatchedMessage[] {
    const mailbox = Mailbox__factory.createInterface();
    const dispatchLogs = findMatchingLogEvents(
      HyperlaneCore.getLogs(sourceTx),
      mailbox,
      'Dispatch',
    );
    return dispatchLogs.map((log) => {
      const message = HyperlaneCore.getDispatchMessage(log);
      const parsed = parseMessage(message);
      const id = messageId(message);
      return { id, message, parsed };
    });
  }

  private static getLogs(
    sourceTx: EvmTxReceipt | ViemTxReceipt,
  ): { data: string; topics: readonly string[] }[] {
    const maybeLogs = asRecord(sourceTx)?.logs;
    if (!Array.isArray(maybeLogs)) return [];
    return maybeLogs.filter(
      (log): log is { data: string; topics: readonly string[] } => {
        const parsed = asRecord(log);
        return (
          !!parsed &&
          typeof parsed.data === 'string' &&
          Array.isArray(parsed.topics)
        );
      },
    );
  }

  private static getDispatchMessage(log: unknown): string {
    const args = asRecord(log)?.args;
    if (Array.isArray(args)) {
      const message = args[3];
      assert(typeof message === 'string', 'Dispatch log args missing message');
      return message;
    }

    const argsObj = asRecord(args);
    const message = argsObj?.message;
    assert(typeof message === 'string', 'Dispatch log args missing message');
    return message;
  }

  private static getTransactionHash(
    sourceTx: EvmTxReceipt | ViemTxReceipt,
  ): string | undefined {
    const transactionHash = asRecord(sourceTx)?.transactionHash;
    return typeof transactionHash === 'string' ? transactionHash : undefined;
  }
}
