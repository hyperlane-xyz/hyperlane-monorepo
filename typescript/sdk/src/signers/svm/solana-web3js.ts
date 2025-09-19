import {
  Connection,
  Keypair,
  TransactionConfirmationStatus,
} from '@solana/web3.js';

import { Address, ProtocolType, retryAsync } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { SolanaWeb3Transaction } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';
import { IMultiProtocolSigner } from '../types.js';

export class SvmMultiprotocolSignerAdapter
  implements IMultiProtocolSigner<ProtocolType.Sealevel>
{
  private readonly signer: Keypair;
  private readonly svmProvider: Connection;
  private readonly commitment: TransactionConfirmationStatus = 'confirmed';

  constructor(
    private readonly chainName: ChainName,
    private readonly privateKey: Uint8Array,
    private readonly multiProtocolProvider: MultiProtocolProvider,
  ) {
    this.signer = Keypair.fromSecretKey(this.privateKey);
    this.svmProvider = this.multiProtocolProvider.getSolanaWeb3Provider(
      this.chainName,
    );
  }

  async address(): Promise<Address> {
    return this.signer.publicKey.toBase58();
  }

  async sendAndConfirmTransaction(tx: SolanaWeb3Transaction): Promise<string> {
    // Manually crafting and sending the transaction as sendTransactionAndConfirm might
    // not always work depending on if the `signatureSubscribe` rpc method is available
    const { blockhash, lastValidBlockHeight } =
      await this.svmProvider.getLatestBlockhash(this.commitment);

    tx.transaction.recentBlockhash = blockhash;
    tx.transaction.lastValidBlockHeight = lastValidBlockHeight;
    tx.transaction.sign(this.signer);

    const txSignature = await this.svmProvider.sendRawTransaction(
      tx.transaction.serialize(),
      {
        maxRetries: 3,
        preflightCommitment: this.commitment,
      },
    );

    // Manually checking if the transaction has been confirmed on chain
    await this.waitForTransaction(txSignature);

    return txSignature;
  }

  async waitForTransaction(transactionHash: string): Promise<void> {
    await retryAsync(
      async () => {
        const res = await this.svmProvider.getSignatureStatus(transactionHash);

        if (res.value?.confirmationStatus !== this.commitment) {
          throw new Error(
            `Transaction ${transactionHash} is not yet in the expected commitment state: "${this.commitment}"`,
          );
        }
      },
      5,
      1500,
    );
  }
}
