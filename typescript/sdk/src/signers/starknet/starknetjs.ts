import { ethers } from 'ethers';
import { base58 } from 'ethers/lib/utils.js';
import { Account as StarknetAccount } from 'starknet';

import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { StarknetJsTransaction } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';
import { IMultiProtocolSigner } from '../types.js';

export class StarknetMultiProtocolSignerAdapter
  implements IMultiProtocolSigner<ProtocolType.Starknet>
{
  private readonly signer: StarknetAccount;

  constructor(
    private readonly chainName: ChainName,
    privateKey: string,
    address: string,
    multiProtocolProvider: MultiProtocolProvider,
  ) {
    const provider = multiProtocolProvider.getStarknetProvider(this.chainName);

    this.signer = new StarknetAccount(
      provider,
      // Assumes that both the private key and the related address are base58 encoded
      // in secrets manager
      ethers.utils.hexlify(base58.decode(address)),
      base58.decode(privateKey),
    );
  }

  async address(): Promise<string> {
    return this.signer.address;
  }

  async sendTransaction(tx: StarknetJsTransaction): Promise<string> {
    const { entrypoint, calldata, contractAddress } = tx.transaction;
    assert(entrypoint, 'entrypoint is required for starknet transactions');

    const transaction = await this.signer.execute([
      {
        contractAddress,
        entrypoint,
        calldata,
      },
    ]);

    const transactionReceipt = await this.signer.waitForTransaction(
      transaction.transaction_hash,
    );

    if (transactionReceipt.isReverted()) {
      throw new Error('Transaction failed');
    }

    return transaction.transaction_hash;
  }
}
