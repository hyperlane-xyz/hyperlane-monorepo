import {
  Account,
  CairoOption,
  CairoOptionVariant,
  InvokeFunctionResponse,
} from 'starknet';

import {
  ChainName,
  DispatchedMessage,
  HyperlaneAddressesMap,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { toStarknetMessageBytes } from '../messaging/messageUtils.js';
import {
  getStarknetMailboxContract,
  parseStarknetDispatchedMessages,
  quoteStarknetDispatch,
} from '../utils/starknet.js';

export interface IMultiProtocolSignerManager {
  getStarknetSigner(chain: ChainName): Account;
}

export class StarknetCore {
  protected logger = rootLogger.child({ module: 'StarknetCore' });
  protected addressesMap: HyperlaneAddressesMap<any>;
  public multiProvider: MultiProvider;
  private multiProtocolSigner: IMultiProtocolSignerManager;

  constructor(
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
    multiProtocolSigner: IMultiProtocolSignerManager,
  ) {
    this.addressesMap = addressesMap;
    this.multiProvider = multiProvider;
    this.multiProtocolSigner = multiProtocolSigner;
  }

  getAddresses(chain: ChainName) {
    return this.addressesMap[chain];
  }

  parseDispatchedMessagesFromReceipt(
    receipt: any,
    origin: ChainName,
  ): DispatchedMessage {
    const mailboxAddress = this.addressesMap[origin].mailbox;
    const mailboxContract = getStarknetMailboxContract(
      mailboxAddress,
      this.multiProtocolSigner.getStarknetSigner(origin),
    );

    const parsedEvents = mailboxContract.parseEvents(receipt);
    return parseStarknetDispatchedMessages(
      parsedEvents,
      (domain) => this.multiProvider.tryGetChainName(domain) ?? undefined,
    )[0];
  }

  async sendMessage(
    origin: ChainName,
    destination: ChainName,
    recipient: Address,
    body: string,
    _hook?: Address,
    _metadata?: string,
  ): Promise<{
    dispatchTx: InvokeFunctionResponse;
    message: DispatchedMessage;
  }> {
    const destinationDomain = this.multiProvider.getDomainId(destination);
    const mailboxAddress = this.addressesMap[origin].mailbox;
    const mailboxContract = getStarknetMailboxContract(
      mailboxAddress,
      this.multiProtocolSigner.getStarknetSigner(origin),
    );

    // Convert messageBody to Bytes struct format
    const messageBodyBytes = toStarknetMessageBytes(
      new TextEncoder().encode(body),
    );
    this.logger.debug({
      messageBodyBytes,
      encoded: new TextEncoder().encode(body),
    });

    const nonOption = new CairoOption(CairoOptionVariant.None);

    // Quote the dispatch first to ensure enough fees are provided
    const quote = await quoteStarknetDispatch({
      mailboxContract,
      destinationDomain,
      recipientAddress: recipient,
      messageBody: messageBodyBytes,
    });

    // Dispatch the message
    const dispatchTx = await mailboxContract.invoke('dispatch', [
      destinationDomain,
      recipient,
      messageBodyBytes,
      BigInt(quote.toString()), //fee amount
      nonOption,
      nonOption,
    ]);

    this.logger.info(
      `Message sent with transaction hash: ${dispatchTx.transaction_hash}`,
    );
    const account = this.multiProtocolSigner.getStarknetSigner(origin);
    const receipt = await account.waitForTransaction(
      dispatchTx.transaction_hash,
    );

    const parsedEvents = mailboxContract.parseEvents(receipt);

    return {
      dispatchTx,
      message: parseStarknetDispatchedMessages(
        parsedEvents,
        (domain) => this.multiProvider.tryGetChainName(domain) ?? undefined,
      )[0],
    };
  }

  onDispatch(
    handler: (message: DispatchedMessage, event: any) => Promise<void>,
    chains = Object.keys(this.addressesMap),
  ): {
    removeHandler: (chains?: ChainName[]) => void;
  } {
    const eventSubscriptions: (() => void)[] = [];

    chains.forEach((originChain) => {
      const account = this.multiProtocolSigner.getStarknetSigner(originChain);
      const mailboxAddress = this.addressesMap[originChain].mailbox;
      const mailboxContract = getStarknetMailboxContract(
        mailboxAddress,
        account,
      );

      this.logger.debug(`Listening for dispatch on ${originChain}`);

      // Set up event listener
      const eventKey = 'contracts::mailbox::mailbox::Dispatch';
      const unsubscribe = mailboxContract.on(eventKey, async (event: any) => {
        const messages = parseStarknetDispatchedMessages(
          [event],
          (domain) => this.multiProvider.tryGetChainName(domain) ?? undefined,
        );
        if (messages.length > 0) {
          const dispatched = messages[0];

          // Add human readable chain names like HyperlaneCore
          dispatched.parsed.originChain = this.multiProvider.getChainName(
            dispatched.parsed.origin,
          );
          dispatched.parsed.destinationChain = this.multiProvider.getChainName(
            dispatched.parsed.destination,
          );

          this.logger.info(
            `Observed message ${dispatched.id} on ${originChain} to ${dispatched.parsed.destinationChain}`,
          );

          await handler(dispatched, event);
        }
      });

      eventSubscriptions.push(unsubscribe);
    });

    return {
      removeHandler: (removeChains?: ChainName[]) => {
        (removeChains ?? chains).forEach((chain, index) => {
          if (eventSubscriptions[index]) {
            eventSubscriptions[index]();
            this.logger.debug(`Stopped listening for dispatch on ${chain}`);
          }
        });
      },
    };
  }

  async deliver(
    message: DispatchedMessage,
    metadata: any,
  ): Promise<{ transaction_hash: string }> {
    const destinationChain = this.multiProvider.getChainName(
      message.parsed.destination,
    );
    const mailboxAddress = this.addressesMap[destinationChain].mailbox;
    const mailboxContract = getStarknetMailboxContract(
      mailboxAddress,
      this.multiProtocolSigner.getStarknetSigner(destinationChain),
    );

    const data = message.message;

    const { transaction_hash } = await mailboxContract.invoke('process', [
      metadata,
      data, // formatted message
    ]);

    this.logger.info(
      `Message processed with transaction hash: ${transaction_hash}`,
    );

    // Wait for transaction to be mined
    await this.multiProtocolSigner
      .getStarknetSigner(destinationChain)
      .waitForTransaction(transaction_hash);

    return { transaction_hash };
  }
}
