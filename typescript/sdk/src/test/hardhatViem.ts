import hre from 'hardhat';
import { toHex } from 'viem';

export type HardhatSignerWithAddress = { address: string; [key: string]: any };

type ProviderLike = {
  send(method: string, params: unknown[]): Promise<unknown>;
  estimateGas(tx: unknown): Promise<unknown>;
  getBlock(tag: unknown): Promise<{ number: number } & Record<string, unknown>>;
  getTransactionReceipt(hash: string): Promise<Record<string, unknown> | null>;
  getCode?(address: string): Promise<string>;
  getStorageAt?(address: string, position: string): Promise<string>;
};

type WalletClientLike = {
  account?: { address: string };
  sendTransaction(request: Record<string, unknown>): Promise<string>;
};

export function getHardhatProvider(): ProviderLike {
  return {
    async send(method: string, params: unknown[]) {
      return hre.network.provider.send(method, params as any[]);
    },
    async estimateGas(tx: unknown) {
      const hexGas = (await hre.network.provider.send('eth_estimateGas', [
        normalizeRpcTx(tx as Record<string, unknown>),
      ])) as string;
      return BigInt(hexGas);
    },
    async getBlock(tag: unknown) {
      const publicClient = await hre.viem.getPublicClient();
      const blockTag =
        typeof tag === 'number'
          ? BigInt(tag)
          : typeof tag === 'string'
            ? tag
            : 'latest';
      const block = await publicClient.getBlock({
        blockNumber: typeof blockTag === 'bigint' ? blockTag : undefined,
        blockTag:
          blockTag === 'latest' || blockTag === 'pending'
            ? blockTag
            : undefined,
      });
      return { ...block, number: Number(block.number) } as {
        number: number;
      } & Record<string, unknown>;
    },
    async getTransactionReceipt(hash: string) {
      const publicClient = await hre.viem.getPublicClient();
      try {
        return (await publicClient.getTransactionReceipt({
          hash: hash as `0x${string}`,
        })) as unknown as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    async getCode(address: string) {
      const publicClient = await hre.viem.getPublicClient();
      return (
        (await publicClient.getCode({
          address: address as `0x${string}`,
        })) || '0x'
      );
    },
    async getStorageAt(address: string, position: string) {
      const publicClient = await hre.viem.getPublicClient();
      return (
        (await publicClient.getStorageAt({
          address: address as `0x${string}`,
          slot: position as `0x${string}`,
        })) || '0x'
      );
    },
  };
}

function attachAddress<T extends HardhatSignerWithAddress>(
  signer: T,
  address: string,
): T {
  signer.address = address;
  return signer;
}

function normalizeRpcTx(tx: Record<string, unknown>): Record<string, unknown> {
  const request = { ...tx };
  const gas = request.gas ?? request.gasLimit;
  const normalized: Record<string, unknown> = {
    ...request,
    gas: toRpcQuantity(gas),
    gasPrice: toRpcQuantity(request.gasPrice),
    maxFeePerGas: toRpcQuantity(request.maxFeePerGas),
    maxPriorityFeePerGas: toRpcQuantity(request.maxPriorityFeePerGas),
    nonce: toRpcQuantity(request.nonce),
    value: toRpcQuantity(request.value),
  };
  if (!normalized.gas) delete normalized.gas;
  if (!normalized.gasPrice) delete normalized.gasPrice;
  if (!normalized.maxFeePerGas) delete normalized.maxFeePerGas;
  if (!normalized.maxPriorityFeePerGas) delete normalized.maxPriorityFeePerGas;
  if (!normalized.nonce) delete normalized.nonce;
  if (!normalized.value) delete normalized.value;
  return normalized;
}

function toRpcQuantity(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return value;
    return toHex(BigInt(value));
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return toHex(BigInt(value));
  }
  if (typeof value === 'object' && 'toString' in value) {
    return toHex(BigInt(value.toString()));
  }
  return undefined;
}

class WalletClientSigner {
  readonly address: string;

  constructor(
    readonly walletClient: WalletClientLike,
    readonly provider?: ProviderLike,
  ) {
    this.address = walletClient.account?.address || '';
  }

  connect(provider: ProviderLike): WalletClientSigner {
    return attachAddress(
      new WalletClientSigner(this.walletClient, provider),
      this.address,
    );
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async estimateGas(tx: unknown): Promise<unknown> {
    const connectedProvider = this.provider || getHardhatProvider();
    return connectedProvider.estimateGas({
      ...(tx as Record<string, unknown>),
      from: this.address,
    });
  }

  async sendTransaction(tx: unknown): Promise<{
    hash: string;
    wait(confirmations?: number): Promise<unknown>;
  }> {
    const hash = await this.walletClient.sendTransaction({
      ...normalizeRpcTx(tx as Record<string, unknown>),
      account: this.walletClient.account,
    });
    return {
      hash,
      wait: async (confirmations = 1) => {
        const provider = this.provider || getHardhatProvider();
        return waitForReceipt(provider, hash, confirmations);
      },
    };
  }
}

class ImpersonatedSigner {
  constructor(
    readonly address: string,
    readonly provider?: ProviderLike,
  ) {}

  connect(provider: ProviderLike): ImpersonatedSigner {
    return attachAddress(
      new ImpersonatedSigner(this.address, provider),
      this.address,
    );
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async estimateGas(tx: unknown): Promise<unknown> {
    const connectedProvider = this.provider || getHardhatProvider();
    return connectedProvider.estimateGas({
      ...(tx as Record<string, unknown>),
      from: this.address,
    });
  }

  async sendTransaction(tx: unknown): Promise<{
    hash: string;
    wait(confirmations?: number): Promise<unknown>;
  }> {
    const connectedProvider = this.provider || getHardhatProvider();
    const hash = (await connectedProvider.send('eth_sendTransaction', [
      {
        ...normalizeRpcTx(tx as Record<string, unknown>),
        from: this.address,
      },
    ])) as string;
    return {
      hash,
      wait: async (confirmations = 1) =>
        waitForReceipt(connectedProvider, hash, confirmations),
    };
  }
}

async function waitForReceipt(
  provider: ProviderLike,
  hash: string,
  confirmations = 1,
) {
  let receipt = await provider.getTransactionReceipt(hash);
  while (!receipt) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    receipt = await provider.getTransactionReceipt(hash);
  }

  if (confirmations <= 1) return receipt;

  const receiptBlock = Number(receipt.blockNumber ?? 0);
  const targetBlock = receiptBlock + confirmations - 1;
  while (true) {
    const latest = await provider.getBlock('latest');
    if (latest.number >= targetBlock) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return provider.getTransactionReceipt(hash);
}

export async function getHardhatSigners(): Promise<HardhatSignerWithAddress[]> {
  const wallets = await hre.viem.getWalletClients();
  return wallets.map((wallet) => {
    const signer = new WalletClientSigner(wallet as WalletClientLike);
    return attachAddress(
      signer as unknown as HardhatSignerWithAddress,
      wallet.account.address,
    );
  });
}

export async function getImpersonatedHardhatSigner(
  account: string,
): Promise<HardhatSignerWithAddress> {
  await hre.network.provider.send('hardhat_impersonateAccount', [account]);
  const signer = new ImpersonatedSigner(account);
  return attachAddress(signer as unknown as HardhatSignerWithAddress, account);
}
