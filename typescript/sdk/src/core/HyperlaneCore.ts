import { TransactionReceipt } from '@ethersproject/providers';
import { ethers } from 'ethers';
import type { TransactionReceipt as ViemTxReceipt } from 'viem';

import {
  IInterchainSecurityModule__factory,
  IMessageRecipient__factory,
  MailboxClient__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import { Mailbox } from '@hyperlane-xyz/core/mailbox';
import {
  Address,
  AddressBytes32,
  ProtocolType,
  assert,
  bytes32ToAddress,
  eqAddress,
  messageId,
  objFilter,
  objMap,
  parseMessage,
  pollAsync,
} from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../app/HyperlaneApp.js';
import { appFromAddressesMapHelper } from '../contracts/contracts.js';
import {
  HyperlaneAddressesMap,
  HyperlaneContractsMap,
} from '../contracts/types.js';
import { OwnableConfig } from '../deploy/types.js';
import { DerivedHookConfigWithAddress, EvmHookReader } from '../hook/read.js';
import { BaseMetadataBuilder } from '../ism/metadata/builder.js';
import { DerivedIsmConfigWithAddress, EvmIsmReader } from '../ism/read.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { RouterConfig } from '../router/types.js';
import { ChainMap, ChainName } from '../types.js';

import { CoreFactories, coreFactories } from './contracts.js';
import { DispatchEvent } from './events.js';
import { DispatchedMessage } from './types.js';

export class HyperlaneCore extends HyperlaneApp<CoreFactories> {
  private metadataBuilder: BaseMetadataBuilder;

  private hookCache: Record<
    ChainName,
    Record<Address, DerivedHookConfigWithAddress>
  > = {};
  private ismCache: Record<
    ChainName,
    Record<Address, DerivedIsmConfigWithAddress>
  > = {};

  constructor(
    contractsMap: HyperlaneContractsMap<CoreFactories>,
    multiProvider: MultiProvider,
  ) {
    super(contractsMap, multiProvider);
    this.metadataBuilder = new BaseMetadataBuilder(this);
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
  ): HyperlaneCore {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      coreFactories,
      multiProvider,
    );
    return new HyperlaneCore(helper.contractsMap, helper.multiProvider);
  }

  getRouterConfig = (
    owners: Address | ChainMap<OwnableConfig>,
  ): ChainMap<RouterConfig> => {
    // get config
    const config = objMap(
      this.contractsMap,
      (chain, contracts): RouterConfig => ({
        mailbox: contracts.mailbox.address,
        owner: typeof owners === 'string' ? owners : owners[chain].owner,
      }),
    );
    // filter for EVM chains
    return objFilter(
      config,
      (chainName, _): _ is RouterConfig =>
        this.multiProvider.getProtocol(chainName) === ProtocolType.Ethereum,
    );
  };

  quoteGasPayment = (
    origin: ChainName,
    destination: ChainName,
    recipient: AddressBytes32,
    body: string,
  ): Promise<ethers.BigNumber> => {
    const destinationId = this.multiProvider.getDomainId(destination);
    return this.contractsMap[origin].mailbox[
      'quoteDispatch(uint32,bytes32,bytes)'
    ](destinationId, recipient, body);
  };

  protected getDestination(message: DispatchedMessage): ChainName {
    return this.multiProvider.getChainName(message.parsed.destination);
  }

  getRecipientIsmAddress(message: DispatchedMessage): Promise<Address> {
    const destinationMailbox = this.contractsMap[this.getDestination(message)];
    const ethAddress = bytes32ToAddress(message.parsed.recipient);
    return destinationMailbox.mailbox.recipientIsm(ethAddress);
  }

  async getIsmConfig(
    chain: ChainName,
    ism: Address,
  ): Promise<DerivedIsmConfigWithAddress> {
    if (this.ismCache[chain]?.[ism]) {
      return this.ismCache[chain][ism];
    }

    const ismReader = new EvmIsmReader(this.multiProvider, chain);
    const config = await ismReader.deriveIsmConfig(ism);
    this.ismCache[chain] ??= {};
    this.ismCache[chain][ism] = config;
    return config;
  }

  async getRecipientIsmConfig(
    message: DispatchedMessage,
  ): Promise<DerivedIsmConfigWithAddress> {
    const chain = this.getDestination(message);
    const ism = await this.getRecipientIsmAddress(message);
    return this.getIsmConfig(chain, ism);
  }

  protected getOrigin(message: DispatchedMessage): ChainName {
    return this.multiProvider.getChainName(message.parsed.origin);
  }

  async getSenderHookAddress(message: DispatchedMessage): Promise<Address> {
    const originChain = this.getOrigin(message);
    const senderAddress = bytes32ToAddress(message.parsed.sender);
    const provider = this.multiProvider.getProvider(originChain);
    try {
      const client = MailboxClient__factory.connect(senderAddress, provider);
      const hook = await client.hook();
      if (!eqAddress(hook, ethers.constants.AddressZero)) {
        return hook;
      }
    } catch (e) {
      this.logger.debug(
        { senderAddress, error: e },
        `Error fetching hook address for sender`,
      );
    }
    const originMailbox = this.contractsMap[originChain].mailbox;
    return originMailbox.defaultHook();
  }

  async getHookConfig(
    chain: ChainName,
    hook: Address,
  ): Promise<DerivedHookConfigWithAddress> {
    if (this.hookCache[chain]?.[hook]) {
      return this.hookCache[chain][hook];
    }

    const hookReader = new EvmHookReader(this.multiProvider, chain);
    const config = await hookReader.deriveHookConfig(hook);
    this.hookCache[chain] ??= {};
    this.hookCache[chain][hook] = config;
    return config;
  }

  async getSenderHookConfig(
    message: DispatchedMessage,
  ): Promise<DerivedHookConfigWithAddress> {
    const originChain = this.getOrigin(message);
    const hook = await this.getSenderHookAddress(message);
    return this.getHookConfig(originChain, hook);
  }

  async buildMetadata(
    message: DispatchedMessage,
    dispatchTx: TransactionReceipt,
  ): Promise<string> {
    const [ism, hook] = await Promise.all([
      this.getRecipientIsmConfig(message),
      this.getSenderHookConfig(message),
    ]);
    this.logger.debug({ ism, hook }, `Fetched context for message`);
    return this.metadataBuilder.build(message, {
      ism,
      hook,
      dispatchTx,
    });
  }

  async getProcessedReceipt(
    message: DispatchedMessage,
  ): Promise<ethers.ContractReceipt> {
    const destinationChain = this.getDestination(message);
    const mailbox = this.contractsMap[destinationChain].mailbox;

    const processedBlock = await mailbox.processedAt(message.id);
    const events = await mailbox.queryFilter(
      mailbox.filters.ProcessId(message.id),
      processedBlock,
      processedBlock,
    );
    const processedEvent = events[0];
    return processedEvent.getTransactionReceipt();
  }

  async relayMessage(
    message: DispatchedMessage,
    dispatchTx: TransactionReceipt,
  ): Promise<ethers.ContractReceipt> {
    assert(
      this.multiProvider.hasChain(message.parsed.origin) &&
        this.multiProvider.hasChain(message.parsed.destination),
      'Chain not supported',
    );

    const destinationChain = this.getDestination(message);
    const mailbox = this.getContracts(destinationChain).mailbox;

    const recipient = IMessageRecipient__factory.connect(
      bytes32ToAddress(message.parsed.recipient),
      mailbox.provider,
    );
    this.logger.debug({ message }, `Simulating recipient message handling`);
    await recipient.estimateGas.handle(
      message.parsed.origin,
      message.parsed.sender,
      message.parsed.body,
      { from: mailbox.address },
    );

    const recipientIsm = await this.getRecipientIsmAddress(message);
    const ism = IInterchainSecurityModule__factory.connect(
      recipientIsm,
      mailbox.provider,
    );

    return pollAsync(
      async () => {
        this.logger.debug(
          { message, recipientIsm },
          `Building recipient ISM metadata`,
        );
        const metadata = await this.buildMetadata(message, dispatchTx);

        this.logger.debug(
          { message, metadata },
          `Simulating recipient ISM verification`,
        );
        const verified = await ism.callStatic.verify(metadata, message.message);
        assert(verified, 'ISM verification failed');

        const isDelivered = await mailbox.delivered(message.id);
        if (isDelivered) {
          this.logger.debug(`Message ${message.id} already delivered`);
          return this.getProcessedReceipt(message);
        }

        this.logger.info(
          { message, metadata },
          `Relaying message ${message.id} to ${destinationChain}`,
        );

        return this.multiProvider.handleTx(
          destinationChain,
          mailbox.process(metadata, message.message),
        );
      },
      5 * 1000, // every 5 seconds
      12, // 12 attempts
    );
  }

  async relay(
    filters = objMap(
      this.contractsMap,
      (): Parameters<Mailbox['filters']['Dispatch']> => [
        undefined,
        undefined,
        undefined,
        undefined,
      ],
    ),
  ): Promise<void> {
    const chains = this.multiProvider.getKnownChainNames();
    await Promise.all(
      chains.map(async (chain) => {
        this.logger.debug(`Hydrating ${chain} default ISM and hook caches`);
        const mailbox = this.getContracts(chain).mailbox;
        const hook = await mailbox.defaultHook();
        const ism = await mailbox.defaultIsm();
        await this.getIsmConfig(chain, ism);
        await this.getHookConfig(chain, hook);
      }),
    );

    for (const [originChain, filter] of Object.entries(filters)) {
      const mailbox = this.getContracts(originChain).mailbox;
      this.logger.debug(`Listening on ${originChain} for messages`);
      mailbox.on<DispatchEvent>(
        mailbox.filters.Dispatch(...filter),
        async (sender, destination, recipient, message, event) => {
          const destinationChain =
            this.multiProvider.tryGetChainName(destination);
          if (destinationChain) {
            this.logger.info(
              { chain: originChain, sender, destination, recipient },
              `Observed message from ${originChain} to ${destinationChain} attempting to relay`,
            );
            const dispatched = HyperlaneCore.parseDispatchedMessage(message);
            const receipt = await event.getTransactionReceipt();
            await this.relayMessage(dispatched, receipt);
          }
        },
      );
    }
  }

  protected waitForProcessReceipt(
    message: DispatchedMessage,
  ): Promise<ethers.ContractReceipt> {
    const id = messageId(message.message);
    const destinationChain = this.getDestination(message);
    const mailbox = this.contractsMap[destinationChain].mailbox;
    const filter = mailbox.filters.ProcessId(id);

    return new Promise<ethers.ContractReceipt>((resolve, reject) => {
      mailbox.once(filter, (emittedId, event) => {
        if (id !== emittedId) {
          reject(`Expected message id ${id} but got ${emittedId}`);
        }
        resolve(
          this.multiProvider.handleTx(destinationChain, event.getTransaction()),
        );
      });
    });
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
    sourceTx: ethers.ContractReceipt | ViemTxReceipt,
  ): Promise<ethers.ContractReceipt[]> {
    const messages = HyperlaneCore.getDispatchedMessages(sourceTx);
    return Promise.all(messages.map((msg) => this.waitForProcessReceipt(msg)));
  }

  // TODO consider renaming this, all the waitForMessage* methods are confusing
  async waitForMessageProcessed(
    sourceTx: ethers.ContractReceipt | ViemTxReceipt,
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
    this.logger.info(
      `All messages processed for tx ${sourceTx.transactionHash}`,
    );
  }

  // Redundant with static method but keeping for backwards compatibility
  getDispatchedMessages(
    sourceTx: TransactionReceipt | ViemTxReceipt,
  ): DispatchedMessage[] {
    return HyperlaneCore.getDispatchedMessages(sourceTx);
  }

  async getDispatchTx(
    originChain: ChainName,
    messageId: string,
  ): Promise<TransactionReceipt> {
    const mailbox = this.contractsMap[originChain].mailbox;
    const filter = mailbox.filters.DispatchId(messageId);
    const matchingEvents = await mailbox.queryFilter(filter);
    if (matchingEvents.length === 0) {
      throw new Error(`No dispatch event found for message ${messageId}`);
    }
    const event = matchingEvents[0]; // only 1 event per message ID
    return event.getTransactionReceipt();
  }

  static parseDispatchedMessage(message: string): DispatchedMessage {
    const parsed = parseMessage(message);
    const id = messageId(message);
    return { id, message, parsed };
  }

  static getDispatchedMessages(
    sourceTx: TransactionReceipt | ViemTxReceipt,
  ): DispatchedMessage[] {
    const mailbox = Mailbox__factory.createInterface();
    const dispatchLogs = sourceTx.logs
      .map((log) => {
        try {
          return mailbox.parseLog(log);
        } catch (e) {
          return undefined;
        }
      })
      .filter(
        (log): log is ethers.utils.LogDescription =>
          !!log && log.name === 'Dispatch',
      );
    return dispatchLogs.map((log) =>
      this.parseDispatchedMessage(log.args['message']),
    );
  }
}
