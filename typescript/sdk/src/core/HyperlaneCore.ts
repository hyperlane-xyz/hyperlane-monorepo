import { TransactionReceipt } from '@ethersproject/providers';
import { ethers } from 'ethers';
import type { TransactionReceipt as ViemTxReceipt } from 'viem';

import { Mailbox__factory } from '@hyperlane-xyz/core';
import {
  Address,
  AddressBytes32,
  ProtocolType,
  addressToBytes32,
  bytes32ToAddress,
  messageId,
  objFilter,
  objMap,
  parseMessage,
  pollAsync,
} from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../app/HyperlaneApp.js';
import { appFromAddressesMapHelper } from '../contracts/contracts.js';
import { HyperlaneAddressesMap } from '../contracts/types.js';
import { OwnableConfig } from '../deploy/types.js';
import { DerivedHookConfig, EvmHookReader } from '../hook/EvmHookReader.js';
import { DerivedIsmConfig, EvmIsmReader } from '../ism/EvmIsmReader.js';
import { BaseMetadataBuilder } from '../ism/metadata/builder.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { RouterConfig } from '../router/types.js';
import { ChainMap, ChainName } from '../types.js';
import { findMatchingLogEvents } from '../utils/logUtils.js';

import { CoreFactories, coreFactories } from './contracts.js';
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
    metadata?: string,
    hook?: Address,
  ): Promise<ethers.BigNumber> => {
    const destinationId = this.multiProvider.getDomainId(destination);
    return this.contractsMap[origin].mailbox[
      'quoteDispatch(uint32,bytes32,bytes,bytes,address)'
    ](
      destinationId,
      recipient,
      body,
      metadata || '0x',
      hook || ethers.constants.AddressZero,
    );
  };

  protected getDestination(message: DispatchedMessage): ChainName {
    return this.multiProvider.getChainName(message.parsed.destination);
  }

  protected getOrigin(message: DispatchedMessage): ChainName {
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

  async buildMetadata(
    message: DispatchedMessage,
    dispatchTx: TransactionReceipt,
  ): Promise<string> {
    const ismConfig = await this.getRecipientIsmConfig(message);
    const hookConfig = await this.getHookConfig(message);

    const baseMetadataBuilder = new BaseMetadataBuilder(this);

    return baseMetadataBuilder.build({
      ism: ismConfig,
      hook: hookConfig,
      message,
      dispatchTx,
    });
  }

  async sendMessage(
    origin: ChainName,
    destination: ChainName,
    recipient: Address,
    body: string,
    hook?: Address,
    metadata?: string,
  ): Promise<{ dispatchTx: TransactionReceipt; message: DispatchedMessage }> {
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
    const dispatchTx = await this.multiProvider.handleTx(
      origin,
      mailbox['dispatch(uint32,bytes32,bytes,bytes,address)'](
        destinationDomain,
        recipientBytes32,
        body,
        metadata || '0x',
        hook || ethers.constants.AddressZero,
        { value: quote },
      ),
    );
    return {
      dispatchTx,
      message: this.getDispatchedMessages(dispatchTx)[0],
    };
  }

  async relayMessage(
    message: DispatchedMessage,
    dispatchTx: ethers.ContractReceipt,
  ): Promise<ethers.ContractReceipt> {
    const metadata = await this.buildMetadata(message, dispatchTx);

    const destinationChain = this.getDestination(message);
    const mailbox = this.contractsMap[destinationChain].mailbox;

    return this.multiProvider.handleTx(
      destinationChain,
      mailbox.process(metadata, message.message),
    );
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
    sourceTx: ethers.ContractReceipt | ViemTxReceipt,
  ): DispatchedMessage[] {
    const messages = HyperlaneCore.getDispatchedMessages(sourceTx);
    return messages.map(({ parsed, ...other }) => {
      const originChain =
        this.multiProvider.tryGetChainName(parsed.origin) ?? undefined;
      const destinationChain =
        this.multiProvider.tryGetChainName(parsed.destination) ?? undefined;
      return { parsed: { ...parsed, originChain, destinationChain }, ...other };
    });
  }

  async getDispatchTx(
    originChain: ChainName,
    messageId: string,
  ): Promise<ethers.ContractReceipt> {
    const mailbox = this.contractsMap[originChain].mailbox;
    const filter = mailbox.filters.DispatchId(messageId);
    const matchingEvents = await mailbox.queryFilter(filter);
    if (matchingEvents.length === 0) {
      throw new Error(`No dispatch event found for message ${messageId}`);
    }
    const event = matchingEvents[0]; // only 1 event per message ID
    return event.getTransactionReceipt();
  }

  static getDispatchedMessages(
    sourceTx: ethers.ContractReceipt | ViemTxReceipt,
  ): DispatchedMessage[] {
    const mailbox = Mailbox__factory.createInterface();
    const dispatchLogs = findMatchingLogEvents(
      sourceTx.logs,
      mailbox,
      'Dispatch',
    );
    return dispatchLogs.map((log) => {
      const message = log.args['message'];
      const parsed = parseMessage(message);
      const id = messageId(message);
      return { id, message, parsed };
    });
  }
}
