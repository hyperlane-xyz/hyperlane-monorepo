import { ethers } from 'ethers';
import { Account as StarknetAccount } from 'starknet';

import { type ProtocolType, assert } from '@hyperlane-xyz/utils';

import { type MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { type StarknetJsTransaction } from '../../providers/ProviderType.js';
import { type ChainName } from '../../types.js';
import { type IMultiProtocolSigner } from '../types.js';

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

    assert(
      ethers.utils.isHexString(address),
      'Starknet address must be a hex string',
    );
    assert(
      ethers.utils.isHexString(privateKey),
      'Starknet private key must be a hex string',
    );

    this.signer = new StarknetAccount(provider, address, privateKey);
  }

  async address(): Promise<string> {
    return this.signer.address;
  }

  async sendAndConfirmTransaction(tx: StarknetJsTransaction): Promise<string> {
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
      throw new Error(
        `Transaction ${transaction.transaction_hash} failed on chain ${this.chainName}`,
      );
    }

    return transaction.transaction_hash;
  }
}
