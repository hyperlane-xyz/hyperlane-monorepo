import { Account, CairoOption, CairoOptionVariant, Contract } from 'starknet';

import {
  ChainName,
  HyperlaneAddressesMap,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { rootLogger } from '@hyperlane-xyz/utils';

export class StarknetCore {
  protected logger = rootLogger.child({ module: 'StarknetCore' });
  protected signer: Account;
  protected addressesMap: HyperlaneAddressesMap<any>;
  protected multiProvider: MultiProvider;

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

  static getMailboxContract(address: string, signer: Account): Contract {
    const { abi } = getCompiledContract('mailbox');
    return new Contract(abi, address, signer);
  }

  async sendMessage(params: {
    origin: ChainName;
    destinationDomain: number;
    recipientAddress: string;
    messageBody: string;
  }): Promise<{ txHash: string; messages: any[] }> {
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
    const { transaction_hash } = await mailboxContract.invoke('dispatch', [
      params.destinationDomain,
      params.recipientAddress,
      messageBodyBytes,
      BigInt(quote.toString()), //fee amount
      nonOption,
      nonOption,
    ]);

    this.logger.info(`Message sent with transaction hash: ${transaction_hash}`);

    const receipt = await this.signer.waitForTransaction(transaction_hash);
    const parsedEvents = mailboxContract.parseEvents(receipt);

    return {
      txHash: transaction_hash,
      messages: this.getDispatchedMessages(parsedEvents),
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

  getDispatchedMessages(parsedEvents: any): any {
    return parsedEvents
      .filter((event: any) => 'contracts::mailbox::mailbox::Dispatch' in event)
      .map((event: any) => {
        const dispatchEvent = event['contracts::mailbox::mailbox::Dispatch'];
        const message = dispatchEvent.message;

        const originChain =
          this.multiProvider.tryGetChainName(message.origin) ?? undefined;
        const destinationChain =
          this.multiProvider.tryGetChainName(message.destination) ?? undefined;

        // Convert the message to the expected format
        // TODO: stringify the message body
        const messageString = {
          version: Number(message.version),
          nonce: Number(message.nonce),
          origin: originChain,
          sender: message.sender.toString(),
          destination: destinationChain,
          recipient: message.recipient.toString(),
          body: Array.from(message.body.data).map((n: any) => n.toString()), // TODO: causes stringify error
        };

        return messageString;
      });
  }
}
