import {
  Account,
  CairoOption,
  CairoOptionVariant,
  Contract,
  InvokeFunctionResponse,
  ParsedEvent,
  ParsedEvents,
  num,
} from 'starknet';

import {
  ChainName,
  DispatchedMessage,
  HyperlaneAddressesMap,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { ParsedMessage, rootLogger } from '@hyperlane-xyz/utils';

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

  /**
   * Convert a byte array to a starknet message
   * Pads the bytes to 16 bytes chunks
   * @param bytes Input byte array
   * @returns Object containing size and padded data array
   */
  static toStarknetMessageBytes(bytes: Uint8Array): {
    size: number;
    data: bigint[];
  } {
    // Calculate the required padding
    const padding = (16 - (bytes.length % 16)) % 16;
    const totalLen = bytes.length + padding;

    // Create a new byte array with the necessary padding
    const paddedBytes = new Uint8Array(totalLen);
    paddedBytes.set(bytes);
    // Padding remains as zeros by default in Uint8Array

    // Convert to chunks of 16 bytes
    const result: bigint[] = [];
    for (let i = 0; i < totalLen; i += 16) {
      const chunk = paddedBytes.slice(i, i + 16);
      // Convert chunk to bigint (equivalent to u128 in Rust)
      const value = BigInt('0x' + Buffer.from(chunk).toString('hex'));
      result.push(value);
    }

    return {
      size: bytes.length,
      data: result,
    };
  }
  getAddresses(chain: ChainName) {
    return this.addressesMap[chain];
  }

  static getMailboxContract(address: string, signer: Account): Contract {
    const { abi } = getCompiledContract('mailbox');
    return new Contract(abi, address, signer);
  }

  async sendMessage(params: {
    origin: ChainName;
    destinationDomain: number;
    recipientAddress: string;
    messageBody: string;
  }): Promise<{
    dispatchTx: InvokeFunctionResponse;
    message: DispatchedMessage;
  }> {
    const mailboxAddress = this.addressesMap[params.origin].mailbox;
    const mailboxContract = StarknetCore.getMailboxContract(
      mailboxAddress,
      this.signer,
    );

    // Convert messageBody to Bytes struct format
    const messageBodyBytes = StarknetCore.toStarknetMessageBytes(
      new TextEncoder().encode(params.messageBody),
    );
    console.log({
      messageBodyBytes,
      encoded: new TextEncoder().encode(params.messageBody),
    });

    const nonOption = new CairoOption(CairoOptionVariant.None);

    // Quote the dispatch first to ensure enough fees are provided
    const quote = await mailboxContract.call('quote_dispatch', [
      params.destinationDomain,
      params.recipientAddress,
      messageBodyBytes,
      nonOption,
      nonOption,
    ]);

    // Dispatch the message
    const dispatchTx = await mailboxContract.invoke('dispatch', [
      params.destinationDomain,
      params.recipientAddress,
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

  async onDispatch(
    handler: (message: DispatchedMessage, event: any) => Promise<void>,
    chains = Object.keys(this.addressesMap),
  ): Promise<{ removeHandler: (chains?: ChainName[]) => void }> {
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
    messageData?: any,
  ): Promise<{ transaction_hash: string }> {
    const destinationChain = this.multiProvider.getChainName(
      message.parsed.destination,
    );
    const mailboxAddress = this.addressesMap[destinationChain].mailbox;
    const mailboxContract = StarknetCore.getMailboxContract(
      mailboxAddress,
      this.signer,
    );

    // Process the message on the destination chain
    const { transaction_hash } = await mailboxContract.invoke('process', [
      metadata,
      messageData || message.message,
    ]);

    this.logger.info(
      `Message processed with transaction hash: ${transaction_hash}`,
    );

    // Wait for transaction to be mined
    await this.signer.waitForTransaction(transaction_hash);

    return { transaction_hash };
  }

  /**
   * Convert a Starknet message to Ethereum message bytes
   */
  static toEthMessageBytes(
    starknetMessage: ParsedMessage & { body: { size: bigint; data: bigint[] } },
  ): Uint8Array {
    // Calculate buffer size based on Rust implementation
    const headerSize = 1 + 4 + 4 + 32 + 4 + 32; // version + nonce + origin + sender + destination + recipient
    const bodyBytes = StarknetCore.u128VecToU8Vec(starknetMessage.body.data);

    // Create buffer with exact size needed
    const buffer = new Uint8Array(headerSize + bodyBytes.length);
    let offset = 0;

    // Write version (1 byte)
    buffer[offset] = Number(starknetMessage.version);
    offset += 1;

    // Write nonce (4 bytes)
    const view = new DataView(buffer.buffer);
    view.setUint32(offset, Number(starknetMessage.nonce), false); // false for big-endian
    offset += 4;

    // Write origin (4 bytes)
    view.setUint32(offset, Number(starknetMessage.origin), false);
    offset += 4;

    // Write sender (32 bytes)
    const senderValue =
      typeof starknetMessage.sender === 'string'
        ? BigInt(starknetMessage.sender)
        : starknetMessage.sender;
    const senderBytes = num.hexToBytes(num.toHex64(senderValue));
    buffer.set(senderBytes, offset);
    offset += 32;

    // Write destination (4 bytes)
    view.setUint32(offset, Number(starknetMessage.destination), false);
    offset += 4;

    // Write recipient (32 bytes)
    const recipientValue =
      typeof starknetMessage.recipient === 'string'
        ? BigInt(starknetMessage.recipient)
        : starknetMessage.recipient;
    const recipientBytes = num.hexToBytes(num.toHex64(recipientValue));
    buffer.set(recipientBytes, offset);
    offset += 32;

    // Write body
    buffer.set(bodyBytes, offset);

    return buffer;
  }

  /**
   * Convert vector of u128 to bytes
   */
  static u128VecToU8Vec(input: bigint[]): Uint8Array {
    const output = new Uint8Array(input.length * 16); // Each u128 takes 16 bytes
    input.forEach((value, index) => {
      const hex = num.toHex(value);
      const bytes = num.hexToBytes(hex.padStart(34, '0')); // Ensure 16 bytes (34 chars including '0x')
      output.set(bytes, index * 16);
    });
    return output;
  }
}
