import { ethers } from 'ethers';
import { assert } from '../utils.js';
import type { WalletConfig } from './types.js';

// Returns an ethers v5 Signer ready to send transactions on chainId.
export async function resolveEvmSigner(
  wallet: WalletConfig,
  chainId: number,
  rpcUrls: Record<number, string>,
): Promise<ethers.Signer> {
  switch (wallet.type) {
    case 'privateKey': {
      const url = rpcUrls[wallet.chainId];
      assert(url, `No RPC URL configured for chain ${wallet.chainId}`);
      const provider = new ethers.providers.JsonRpcProvider(
        url,
        wallet.chainId,
      );
      return new ethers.Wallet(wallet.key, provider);
    }

    case 'ethersSigner':
      return wallet.signer;

    case 'viemWalletClient': {
      // Wrap the viem WalletClient in an ethers Signer shim.
      // We only need signTransaction + sendTransaction for execution.
      const url = rpcUrls[chainId];
      assert(url, `No RPC URL configured for chain ${chainId}`);
      const provider = new ethers.providers.JsonRpcProvider(url, chainId);
      return new ViemWalletClientSigner(
        wallet.client,
        wallet.account,
        provider,
      );
    }
  }
}

// Minimal ethers Signer that delegates signing to a viem WalletClient.
// Only implements the methods the executor needs.
class ViemWalletClientSigner extends ethers.Signer {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly viemClient: any,
    private readonly _account: `0x${string}`,
    provider: ethers.providers.Provider,
  ) {
    super();
    Object.defineProperty(this, 'provider', { value: provider });
  }

  async getAddress(): Promise<string> {
    return this._account;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    return this.viemClient.signMessage({
      account: this._account,
      message: typeof message === 'string' ? message : { raw: message },
    });
  }

  async signTransaction(
    _transaction: ethers.providers.TransactionRequest,
  ): Promise<string> {
    throw new Error(
      'signTransaction not supported for viemWalletClient; use sendTransaction',
    );
  }

  async sendTransaction(
    transaction: ethers.providers.TransactionRequest,
  ): Promise<ethers.providers.TransactionResponse> {
    const hash: `0x${string}` = await this.viemClient.sendTransaction({
      account: this._account,
      to: transaction.to as `0x${string}` | undefined,
      data: transaction.data as `0x${string}` | undefined,
      value:
        transaction.value != null
          ? ethers.BigNumber.from(transaction.value).toBigInt()
          : undefined,
      gas:
        transaction.gasLimit != null
          ? ethers.BigNumber.from(transaction.gasLimit).toBigInt()
          : undefined,
      gasPrice:
        transaction.gasPrice != null
          ? ethers.BigNumber.from(transaction.gasPrice).toBigInt()
          : undefined,
      nonce: transaction.nonce != null ? Number(transaction.nonce) : undefined,
    });
    // Resolve the TransactionResponse via the provider.
    const provider = this.provider as ethers.providers.JsonRpcProvider;
    let tx: ethers.providers.TransactionResponse | null = null;
    while (!tx) {
      tx = await provider.getTransaction(hash);
      if (!tx) await sleep(500);
    }
    return tx;
  }

  connect(provider: ethers.providers.Provider): ViemWalletClientSigner {
    return new ViemWalletClientSigner(this.viemClient, this._account, provider);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
