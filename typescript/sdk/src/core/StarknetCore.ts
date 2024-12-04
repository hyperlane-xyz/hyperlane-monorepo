import { Account, CairoOption, CairoOptionVariant, Contract } from 'starknet';

import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { rootLogger } from '@hyperlane-xyz/utils';

export class StarknetCore {
  protected logger = rootLogger.child({ module: 'StarknetCore' });
  protected signer: Account;

  constructor(signer: Account) {
    this.signer = signer;
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

  async sendMessage(params: {
    destinationDomain: number;
    recipientAddress: string;
    messageBody: string;
  }): Promise<{ txHash: string }> {
    const { abi } = getCompiledContract('mailbox');
    const mailboxContract = new Contract(
      abi,
      '0x00581bb8ad9e4ecd0ba06793e2ffb26f4b12ea18ec69dfb216738efe569e2e59',
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

    return {
      txHash: transaction_hash,
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
}
