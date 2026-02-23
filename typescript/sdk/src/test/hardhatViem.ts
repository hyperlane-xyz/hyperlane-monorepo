import { createRequire } from 'module';
import { toHex } from 'viem';

export type HardhatSignerWithAddress = { address: string };

type HardhatPublicClientLike = {
  getBlock(args: {
    blockNumber?: bigint;
    blockTag?: 'latest' | 'pending';
  }): Promise<{ number: bigint } & Record<string, unknown>>;
  getBlockNumber(): Promise<bigint>;
  getBalance(args: { address: `0x${string}` }): Promise<bigint>;
  getTransactionReceipt(args: {
    hash: `0x${string}`;
  }): Promise<Record<string, unknown>>;
};

type ProviderLike = {
  send(method: string, params: unknown[]): Promise<unknown>;
  estimateGas(tx: unknown): Promise<unknown>;
  getBlock(tag: unknown): Promise<{ number: number } & Record<string, unknown>>;
  getBlockNumber?(): Promise<number>;
  getBalance?(address: string): Promise<bigint>;
  getTransactionCount?(address: string, blockTag?: string): Promise<number>;
  getLogs?(filter: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  getTransactionReceipt(hash: string): Promise<Record<string, unknown> | null>;
  getCode?(
    address: string,
    blockTag?: string | number | bigint,
  ): Promise<string>;
  getStorageAt?(
    address: string,
    position: string,
    blockTag?: string | number | bigint,
  ): Promise<string>;
};

type WalletClientLike = {
  account: { address: string };
  sendTransaction(request: Record<string, unknown>): Promise<string>;
};

type HardhatRuntimeEnvironmentLike = {
  network: {
    provider: {
      send(method: string, params: unknown[]): Promise<unknown>;
    };
  };
  viem: {
    getPublicClient(): Promise<HardhatPublicClientLike>;
    getWalletClients(): Promise<WalletClientLike[]>;
  };
};

const require = createRequire(import.meta.url);
let cachedHre: HardhatRuntimeEnvironmentLike | undefined;

function getHardhatRuntimeEnvironment(): HardhatRuntimeEnvironmentLike {
  if (!cachedHre) {
    cachedHre = require('hardhat') as HardhatRuntimeEnvironmentLike;
  }
  return cachedHre;
}

async function getHardhatPublicClient(): Promise<HardhatPublicClientLike> {
  return getHardhatRuntimeEnvironment().viem.getPublicClient();
}

function sendHardhatRpc(method: string, params: unknown[]) {
  return getHardhatRuntimeEnvironment().network.provider.send(
    method,
    sanitizedRpcParams(params),
  );
}

export function getHardhatProvider(): ProviderLike {
  return {
    async send(method: string, params: unknown[]) {
      return sendHardhatRpc(method, params);
    },
    async estimateGas(tx: unknown) {
      const hexGas = (await sendHardhatRpc('eth_estimateGas', [
        normalizeRpcTx(tx as Record<string, unknown>),
      ])) as string;
      return BigInt(hexGas);
    },
    async getBlock(tag: unknown) {
      const publicClient = await getHardhatPublicClient();
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
    async getBlockNumber() {
      const publicClient = await getHardhatPublicClient();
      return Number(await publicClient.getBlockNumber());
    },
    async getBalance(address: string) {
      const publicClient = await getHardhatPublicClient();
      return publicClient.getBalance({
        address: address as `0x${string}`,
      });
    },
    async getTransactionReceipt(hash: string) {
      const publicClient = await getHardhatPublicClient();
      try {
        return (await publicClient.getTransactionReceipt({
          hash: hash as `0x${string}`,
        })) as unknown as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    async getTransactionCount(address: string, blockTag = 'latest') {
      const count = (await sendHardhatRpc('eth_getTransactionCount', [
        address,
        blockTag,
      ])) as string;
      return Number(BigInt(count));
    },
    async getLogs(filter: Record<string, unknown>) {
      return (await sendHardhatRpc('eth_getLogs', [
        normalizeLogFilter(filter),
      ])) as Record<string, unknown>[];
    },
    async getCode(
      address: string,
      blockTag: string | number | bigint = 'latest',
    ) {
      return ((await sendHardhatRpc('eth_getCode', [
        address,
        toRpcBlockTag(blockTag),
      ])) || '0x') as string;
    },
    async getStorageAt(
      address: string,
      position: string,
      blockTag: string | number | bigint = 'latest',
    ) {
      return ((await sendHardhatRpc('eth_getStorageAt', [
        address,
        position,
        toRpcBlockTag(blockTag),
      ])) || '0x') as string;
    },
  };
}

function normalizeRpcTx(tx: Record<string, unknown>): Record<string, unknown> {
  const request = { ...tx };
  const gas = request.gas ?? request.gasLimit;
  const normalized: Record<string, unknown> = {
    ...request,
    chainId: toRpcQuantity(request.chainId),
    gas: toRpcQuantity(gas),
    gasPrice: toRpcQuantity(request.gasPrice),
    maxFeePerGas: toRpcQuantity(request.maxFeePerGas),
    maxPriorityFeePerGas: toRpcQuantity(request.maxPriorityFeePerGas),
    nonce: toRpcQuantity(request.nonce),
    value: toRpcQuantity(request.value),
  };
  if (!normalized.chainId) delete normalized.chainId;
  if (!normalized.gas) delete normalized.gas;
  if (!normalized.gasPrice) delete normalized.gasPrice;
  if (!normalized.maxFeePerGas) delete normalized.maxFeePerGas;
  if (!normalized.maxPriorityFeePerGas) delete normalized.maxPriorityFeePerGas;
  if (!normalized.nonce) delete normalized.nonce;
  if (!normalized.value) delete normalized.value;
  return sanitizedRpcValue(normalized) as Record<string, unknown>;
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

function toRpcBlockTag(blockTag: string | number | bigint): string {
  if (typeof blockTag === 'number' || typeof blockTag === 'bigint') {
    return toHex(BigInt(blockTag));
  }
  if (/^[0-9]+$/.test(blockTag)) {
    return toHex(BigInt(blockTag));
  }
  return blockTag;
}

function normalizeLogFilter(filter: Record<string, unknown>) {
  const normalized = { ...filter };
  if (normalized.fromBlock !== undefined) {
    normalized.fromBlock = toRpcBlockTag(
      normalized.fromBlock as string | number | bigint,
    );
  }
  if (normalized.toBlock !== undefined) {
    normalized.toBlock = toRpcBlockTag(
      normalized.toBlock as string | number | bigint,
    );
  }
  return normalized;
}

function sanitizedRpcValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return toHex(value);
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'toBigInt' in value &&
    typeof (value as { toBigInt?: unknown }).toBigInt === 'function'
  ) {
    return toHex((value as { toBigInt: () => bigint }).toBigInt());
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizedRpcValue(item));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizedRpcValue(item),
      ]),
    );
  }

  return value;
}

function sanitizedRpcParams(params: unknown[]): unknown[] {
  return sanitizedRpcValue(params) as unknown[];
}

class WalletClientSigner {
  readonly address: string;

  constructor(
    readonly walletClient: WalletClientLike,
    readonly provider: ProviderLike = getHardhatProvider(),
  ) {
    this.address = walletClient.account.address;
  }

  connect(provider: ProviderLike): WalletClientSigner {
    return new WalletClientSigner(this.walletClient, provider);
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async estimateGas(tx: unknown): Promise<unknown> {
    return this.provider.estimateGas({
      ...(tx as Record<string, unknown>),
      from: this.address,
    });
  }

  async getTransactionCount(blockTag = 'latest'): Promise<number> {
    if (this.provider.getTransactionCount) {
      return this.provider.getTransactionCount(this.address, blockTag);
    }
    const count = (await this.provider.send('eth_getTransactionCount', [
      this.address,
      blockTag,
    ])) as string;
    return Number(BigInt(count));
  }

  async getBalance(): Promise<bigint> {
    if (this.provider.getBalance) {
      return this.provider.getBalance(this.address);
    }
    const balance = (await this.provider.send('eth_getBalance', [
      this.address,
      'latest',
    ])) as string;
    return BigInt(balance);
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
        return waitForReceipt(this.provider, hash, confirmations);
      },
    };
  }
}

class ImpersonatedSigner {
  constructor(
    readonly address: string,
    readonly provider: ProviderLike = getHardhatProvider(),
  ) {}

  connect(provider: ProviderLike): ImpersonatedSigner {
    return new ImpersonatedSigner(this.address, provider);
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async estimateGas(tx: unknown): Promise<unknown> {
    return this.provider.estimateGas({
      ...(tx as Record<string, unknown>),
      from: this.address,
    });
  }

  async getTransactionCount(blockTag = 'latest'): Promise<number> {
    if (this.provider.getTransactionCount) {
      return this.provider.getTransactionCount(this.address, blockTag);
    }
    const count = (await this.provider.send('eth_getTransactionCount', [
      this.address,
      blockTag,
    ])) as string;
    return Number(BigInt(count));
  }

  async getBalance(): Promise<bigint> {
    if (this.provider.getBalance) {
      return this.provider.getBalance(this.address);
    }
    const balance = (await this.provider.send('eth_getBalance', [
      this.address,
      'latest',
    ])) as string;
    return BigInt(balance);
  }

  async sendTransaction(tx: unknown): Promise<{
    hash: string;
    wait(confirmations?: number): Promise<unknown>;
  }> {
    const hash = (await this.provider.send('eth_sendTransaction', [
      sanitizedRpcValue({
        ...normalizeRpcTx(tx as Record<string, unknown>),
        from: this.address,
      }),
    ])) as string;
    return {
      hash,
      wait: async (confirmations = 1) =>
        waitForReceipt(this.provider, hash, confirmations),
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
  const wallets = await getHardhatRuntimeEnvironment().viem.getWalletClients();
  return wallets.map((wallet) => new WalletClientSigner(wallet));
}

export async function getImpersonatedHardhatSigner(
  account: string,
): Promise<HardhatSignerWithAddress> {
  await getHardhatRuntimeEnvironment().network.provider.send(
    'hardhat_impersonateAccount',
    [account],
  );
  return new ImpersonatedSigner(account);
}
