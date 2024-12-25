import {
  Account,
  CairoOption,
  CairoOptionVariant,
  Contract,
  InvokeFunctionResponse,
  ParsedEvent,
  ParsedEvents,
} from 'starknet';

import {
  ChainName,
  DispatchedMessage,
  HyperlaneAddressesMap,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { toStarknetMessageBytes } from '../messaging/messageUtils.js';

export interface IMultiProtocolSignerManager {
  getStarknetSigner(chain: ChainName): Account;
}

export class StarknetCore {
  protected logger = rootLogger.child({ module: 'StarknetCore' });
  // public signer: Account;
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

  static getMailboxContract(address: string, signer: Account): Contract {
    const { abi } = getCompiledContract('mailbox');
    return new Contract(abi, address, signer);
  }

  async sendMessage(
    origin: ChainName,
    destination: ChainName,
    recipient: Address,
    body: string,
    hook?: Address,
    metadata?: string,
  ): Promise<{
    dispatchTx: InvokeFunctionResponse;
    message: DispatchedMessage;
  }> {
    const destinationDomain = this.multiProvider.getDomainId(destination);
    const mailboxAddress = this.addressesMap[origin].mailbox;
    const mailboxContract = StarknetCore.getMailboxContract(
      mailboxAddress,
      this.multiProtocolSigner.getStarknetSigner(origin),
    );

    // Convert messageBody to Bytes struct format
    const messageBodyBytes = toStarknetMessageBytes(
      new TextEncoder().encode(body),
    );
    console.log({
      messageBodyBytes,
      encoded: new TextEncoder().encode(body),
    });

    const nonOption = new CairoOption(CairoOptionVariant.None);

    // Quote the dispatch first to ensure enough fees are provided
    const quote = await this.quoteDispatch({
      mailboxContract,
      destinationDomain,
      recipientAddress: recipient,
      messageBody: body,
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
      message: this.getDispatchedMessages(parsedEvents)[0],
    };
  }

  async quoteDispatch({
    mailboxContract,
    destinationDomain,
    recipientAddress,
    messageBody,
    customHookMetadata,
    customHook,
  }: {
    mailboxContract: Contract;
    destinationDomain: number;
    recipientAddress: string;
    messageBody: string;
    customHookMetadata?: string;
    customHook?: string;
  }): Promise<string> {
    const nonOption = new CairoOption(CairoOptionVariant.None);

    const quote = await mailboxContract.call('quote_dispatch', [
      destinationDomain,
      recipientAddress,
      messageBody,
      customHookMetadata || nonOption,
      customHook || nonOption,
    ]);

    return quote.toString();
  }

  getDispatchedMessages(parsedEvents: ParsedEvents): DispatchedMessage[] {
    return parsedEvents
      .filter(
        (event: ParsedEvent) =>
          'contracts::mailbox::mailbox::Dispatch' in event,
      )
      .map((event: any) => {
        const dispatchEvent = event['contracts::mailbox::mailbox::Dispatch'];
        const message = dispatchEvent.message;

        const originChain =
          this.multiProvider.tryGetChainName(message.origin) ?? undefined;
        const destinationChain =
          this.multiProvider.tryGetChainName(message.destination) ?? undefined;

        // Convert numeric strings to hex addresses with '0x' prefix
        // Convert felt values to hex addresses

        return {
          parsed: {
            ...message,
            originChain,
            destinationChain,
          },
          id: event.index,
          message: message.raw,
        } as DispatchedMessage;
      });
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
      const mailboxContract = StarknetCore.getMailboxContract(
        mailboxAddress,
        account,
      );

      this.logger.debug(`Listening for dispatch on ${originChain}`);

      // Set up event listener
      const eventKey = 'contracts::mailbox::mailbox::Dispatch';
      const unsubscribe = mailboxContract.on(eventKey, async (event: any) => {
        const messages = this.getDispatchedMessages([event]);
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
    const mailboxContract = StarknetCore.getMailboxContract(
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
