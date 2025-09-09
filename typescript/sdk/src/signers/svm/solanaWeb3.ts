import { Keypair, sendAndConfirmTransaction } from '@solana/web3.js';

import { Address, ProtocolType, strip0x } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { SolanaWeb3Transaction } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';
import { IMultiProtocolSigner } from '../types.js';

export class SvmMultiprotocolSignerAdapter
  implements IMultiProtocolSigner<ProtocolType.Sealevel>
{
  private readonly signer: Keypair;

  constructor(
    private readonly chainName: ChainName,
    private readonly privateKey: string,
    private readonly multiProtocolProvider: MultiProtocolProvider,
  ) {
    this.signer = Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(String(Buffer.from(strip0x(this.privateKey), 'base64'))),
      ),
    );
  }

  async address(): Promise<Address> {
    return this.signer.publicKey.toBase58();
  }

  async sendTransaction(tx: SolanaWeb3Transaction): Promise<string> {
    const svmProvider = this.multiProtocolProvider.getSolanaWeb3Provider(
      this.chainName,
    );

    const txSignature = await sendAndConfirmTransaction(
      svmProvider,
      tx.transaction,
      [this.signer],
    );

    return txSignature;
  }
}
