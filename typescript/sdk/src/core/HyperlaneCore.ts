import { TransactionReceipt } from '@ethersproject/providers';
import { ethers } from 'ethers';
import type { TransactionReceipt as ViemTxReceipt } from 'viem';

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
  bytes32ToAddress,
  eqAddress,
  messageId,
  objFilter,
  objMap,
  parseMessage,
  pollAsync,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../app/HyperlaneApp.js';
import { appFromAddressesMapHelper } from '../contracts/contracts.js';
import { HyperlaneAddressesMap } from '../contracts/types.js';
import { OwnableConfig } from '../deploy/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { RouterConfig } from '../router/types.js';
import { ChainMap, ChainName } from '../types.js';

import { CoreFactories, coreFactories } from './contracts.js';
import { DispatchEvent } from './events.js';
import { DispatchedMessage } from './types.js';

export class HyperlaneCore extends HyperlaneApp<CoreFactories> {
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

  onDispatch(
    handler: (
      message: DispatchedMessage,
      event: DispatchEvent,
    ) => Promise<void>,
  ): void {
    objMap(this.contractsMap, (originChain, { mailbox }) =>
      mailbox.on<DispatchEvent>(
        mailbox.filters.Dispatch(),
        (sender, destination, recipient, message, event) => {
          const parsed = HyperlaneCore.parseDispatchedMessage(message);
          this.logger.info(
            `Observed message ${parsed.id} from ${sender} on ${originChain} to ${recipient} on ${destination}`,
          );
          return handler(parsed, event);
        },
      ),
    );
  }

  getDefaults(): Promise<ChainMap<{ ism: Address; hook: Address }>> {
    return promiseObjAll(
      objMap(this.contractsMap, async (_, contracts) => ({
        ism: await contracts.mailbox.defaultIsm(),
        hook: await contracts.mailbox.defaultHook(),
      })),
    );
  }

  getDestination(message: DispatchedMessage): ChainName {
    return this.multiProvider.getChainName(message.parsed.destination);
  }

  getIsm(
    destinationChain: ChainName,
    recipientAddress: Address,
  ): Promise<Address> {
    const destinationMailbox = this.contractsMap[destinationChain];
    return destinationMailbox.mailbox.recipientIsm(recipientAddress);
  }

  getRecipientIsmAddress(message: DispatchedMessage): Promise<Address> {
    const destinationChain = this.getDestination(message);
    const ethAddress = bytes32ToAddress(message.parsed.recipient);
    return this.getIsm(destinationChain, ethAddress);
  }

  protected getRecipient(message: DispatchedMessage): IMessageRecipient {
    return IMessageRecipient__factory.connect(
      bytes32ToAddress(message.parsed.recipient),
      this.multiProvider.getProvider(this.getDestination(message)),
    );
  }

  estimateHandle(message: DispatchedMessage): Promise<ethers.BigNumber> {
    return this.getRecipient(message).estimateGas.handle(
      message.parsed.origin,
      message.parsed.sender,
      message.parsed.body,
      { from: this.getAddresses(this.getDestination(message)).mailbox },
    );
  }

  process(
    message: DispatchedMessage,
    metadata: string,
  ): Promise<ethers.ContractReceipt> {
    const destinationChain = this.getDestination(message);
    return this.multiProvider.handleTx(
      destinationChain,
      this.getContracts(destinationChain).mailbox.process(
        metadata,
        message.message,
      ),
    );
  }

  getOrigin(message: DispatchedMessage): ChainName {
    return this.multiProvider.getChainName(message.parsed.origin);
  }

  async getHook(
    originChain: ChainName,
    senderAddress: Address,
  ): Promise<Address> {
    const provider = this.multiProvider.getProvider(originChain);
    try {
      const client = MailboxClient__factory.connect(senderAddress, provider);
      const hook = await client.hook();
      if (!eqAddress(hook, ethers.constants.AddressZero)) {
        return hook;
      }
    } catch (e) {}
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
    // TODO: scan and chunk if necessary
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
