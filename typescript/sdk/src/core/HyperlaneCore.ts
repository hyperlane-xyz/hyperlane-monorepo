import { ethers } from 'ethers';
import type { TransactionReceipt as ViemTxReceipt } from 'viem';

import { Mailbox__factory } from '@hyperlane-xyz/core';
import {
  Address,
  AddressBytes32,
  ProtocolType,
  messageId,
  objFilter,
  objMap,
  parseMessage,
  pollAsync,
} from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../app/HyperlaneApp.js';
import { chainMetadata } from '../consts/chainMetadata.js';
import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../consts/environments/index.js';
import { appFromAddressesMapHelper } from '../contracts/contracts.js';
import { HyperlaneAddressesMap } from '../contracts/types.js';
import { OwnableConfig } from '../deploy/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { RouterConfig } from '../router/types.js';
import { ChainMap, ChainName } from '../types.js';

import { CoreFactories, coreFactories } from './contracts.js';
import { DispatchedMessage } from './types.js';

export class HyperlaneCore extends HyperlaneApp<CoreFactories> {
  static fromEnvironment<Env extends HyperlaneEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
  ): HyperlaneCore {
    const envAddresses = hyperlaneEnvironments[env];
    if (!envAddresses) {
      throw new Error(`No addresses found for ${env}`);
    }
    return HyperlaneCore.fromAddressesMap(envAddresses, multiProvider);
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
    const config = objMap(this.contractsMap, (chain, contracts) => ({
      mailbox: contracts.mailbox.address,
      owner: typeof owners === 'string' ? owners : owners[chain].owner,
    }));
    // filter for EVM chains
    return objFilter(
      config,
      (chainName, _): _ is RouterConfig =>
        chainMetadata[chainName].protocol === ProtocolType.Ethereum,
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
    return HyperlaneCore.getDispatchedMessages(sourceTx);
  }

  static getDispatchedMessages(
    sourceTx: ethers.ContractReceipt | ViemTxReceipt,
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
    return dispatchLogs.map((log) => {
      const message = log.args['message'];
      const parsed = parseMessage(message);
      const id = messageId(message);
      return { id, message, parsed };
    });
  }
}
