import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  RadixSDKReceipt,
  RadixSDKTransaction,
  RadixSigner,
} from '@hyperlane-xyz/radix-sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { RadixTransaction } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';
import { IMultiProtocolSigner } from '../types.js';

export class RadixMultiProtocolSignerAdapter
  implements IMultiProtocolSigner<ProtocolType.Radix>
{
  constructor(
    private readonly chainName: ChainName,
    private readonly signer: AltVM.ISigner<
      RadixSDKTransaction,
      RadixSDKReceipt
    >,
  ) {}

  static async init(
    chainName: ChainName,
    privateKey: string,
    multiProtocolProvider: MultiProtocolProvider,
  ): Promise<RadixMultiProtocolSignerAdapter> {
    const metadata = multiProtocolProvider.getChainMetadata(chainName);

    const signer = await RadixSigner.connectWithSigner([], privateKey, {
      metadata,
    });

    return new RadixMultiProtocolSignerAdapter(chainName, signer);
  }

  async address(): Promise<string> {
    return this.signer.getSignerAddress();
  }

  async sendAndConfirmTransaction(tx: RadixTransaction): Promise<string> {
    try {
      await this.signer.estimateTransactionFee({
        transaction: tx.transaction,
        estimatedGasPrice: '',
        senderAddress: '',
      });

      const { transactionHash } = await this.signer.sendAndConfirmTransaction(
        tx.transaction,
      );

      return transactionHash;
    } catch (err) {
      throw new Error(`Transaction failed on chain ${this.chainName}`, {
        cause: err,
      });
    }
  }
}
