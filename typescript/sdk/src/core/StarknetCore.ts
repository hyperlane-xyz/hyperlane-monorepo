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

export class StarknetCore {
  protected logger = rootLogger.child({ module: 'StarknetCore' });
  public signer: Account;
  protected addressesMap: HyperlaneAddressesMap<any>;
  public multiProvider: MultiProvider;

  constructor(
    signer: Account, // Use MultiProtocolSignerManager instead
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
  ) {
    this.signer = signer;
    this.addressesMap = addressesMap;
    this.multiProvider = multiProvider;
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
    console.log({ hook, metadata });

    const destinationDomain = this.multiProvider.getDomainId(destination);
    const mailboxAddress = this.addressesMap[origin].mailbox;
    const mailboxContract = StarknetCore.getMailboxContract(
      mailboxAddress,
      this.signer,
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
    const quote = await mailboxContract.call('quote_dispatch', [
      destinationDomain,
      recipient,
      messageBodyBytes,
      nonOption,
      nonOption,
    ]);

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

    const receipt = await this.signer.waitForTransaction(
      dispatchTx.transaction_hash,
    );

    const parsedEvents = mailboxContract.parseEvents(receipt);

    return {
      dispatchTx,
      message: this.getDispatchedMessages(parsedEvents)[0],
    };
  }

  async quoteDispatch(params: {
    destinationDomain: number;
    recipientAddress: string;
    messageBody: string;
    customHookMetadata?: string;
    customHook?: string;
  }): Promise<string> {
    const { abi } = getCompiledContract('mailbox');
    const mailboxContract = new Contract(abi, 'mailbox_address', this.signer);

    const quote = await mailboxContract.call('quote_dispatch', [
      params.destinationDomain,
      params.recipientAddress,
      params.messageBody,
      params.customHookMetadata || '',
      params.customHook || '',
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
      const mailboxAddress = this.addressesMap[originChain].mailbox;
      const mailboxContract = StarknetCore.getMailboxContract(
        mailboxAddress,
        this.signer,
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
      this.signer,
    );

    console.log({ msg: message.message });

    // Process the message on the destination chain
    const { transaction_hash } = await mailboxContract.invoke('process', [
      metadata,
      message.message,
    ]);

    this.logger.info(
      `Message processed with transaction hash: ${transaction_hash}`,
    );

    // Wait for transaction to be mined
    await this.signer.waitForTransaction(transaction_hash);

    return { transaction_hash };
  }
}
