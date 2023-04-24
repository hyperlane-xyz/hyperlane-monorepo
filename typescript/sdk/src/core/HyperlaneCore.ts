import { ethers } from 'ethers';

import { Mailbox, Mailbox__factory } from '@hyperlane-xyz/core';
import { types, utils } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../consts/environments';
import { HyperlaneAddressesMap, appFromAddressesMapHelper } from '../contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

import { CoreFactories, coreFactories } from './contracts';

export type DispatchedMessage = {
  id: string;
  message: string;
  parsed: types.ParsedMessage;
};

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

  protected getDestination(message: DispatchedMessage): {
    destinationChain: ChainName;
    mailbox: Mailbox;
  } {
    const destinationChain = this.multiProvider.getChainName(
      message.parsed.destination,
    );
    const mailbox = this.getContracts(destinationChain).mailbox;
    return { destinationChain, mailbox };
  }

  protected waitForProcessReceipt(
    message: DispatchedMessage,
  ): Promise<ethers.ContractReceipt> {
    const id = utils.messageId(message.message);
    const { destinationChain, mailbox } = this.getDestination(message);
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

  protected async waitForMessageWasProcessed(
    message: DispatchedMessage,
  ): Promise<void> {
    const id = utils.messageId(message.message);
    const { mailbox } = this.getDestination(message);
    await utils.pollAsync(async () => {
      const delivered = await mailbox.delivered(id);
      if (!delivered) {
        throw new Error(`Message ${id} not yet processed`);
      }
    });
    return;
  }

  waitForMessageProcessing(
    sourceTx: ethers.ContractReceipt,
  ): Promise<ethers.ContractReceipt[]> {
    const messages = HyperlaneCore.getDispatchedMessages(sourceTx);
    return Promise.all(messages.map((msg) => this.waitForProcessReceipt(msg)));
  }

  async waitForMessageProcessed(
    sourceTx: ethers.ContractReceipt,
  ): Promise<void> {
    const messages = HyperlaneCore.getDispatchedMessages(sourceTx);
    await Promise.all(
      messages.map((msg) => this.waitForMessageWasProcessed(msg)),
    );
  }

  // Redundant with static method but keeping for backwards compatibility
  getDispatchedMessages(sourceTx: ethers.ContractReceipt): DispatchedMessage[] {
    return HyperlaneCore.getDispatchedMessages(sourceTx);
  }

  static getDispatchedMessages(
    sourceTx: ethers.ContractReceipt,
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
      const parsed = utils.parseMessage(message);
      const id = utils.messageId(message);
      return { id, message, parsed };
    });
  }
}
