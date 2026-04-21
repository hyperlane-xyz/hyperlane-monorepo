import { ethers } from 'ethers';
import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  ensure0x,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';
import type { Logger } from 'pino';

import type {
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  ExternalBridgeConfig,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import {
  ERC20_ABI,
  ETHEREUM_CHAIN_ID,
  KATANA_CHAIN_ID,
  KATANA_FORWARD_CONFIG,
  KATANA_REVERSE_CONFIG,
} from './katanaUtils.js';

type KatanaDirection = 'ethereum-to-katana' | 'katana-to-ethereum';

type ArcApiSuccess<T> = {
  status: 'success';
  data: T;
};

type ArcApiError = {
  status: 'error';
  message: string;
  name?: string;
  code?: number;
};

type ArcApiResponse<T> = ArcApiSuccess<T> | ArcApiError;

type ArcFeeCost = {
  amount: string;
  included?: boolean;
};

type ArcGasCost = {
  amount: string;
};

type ArcStep = {
  estimate: {
    approvalAddress: string | null;
  };
};

type ArcUnsignedTransaction = {
  from?: string;
  to: string;
  data: string;
  value: string;
  gasLimit?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  chainId: number;
};

type ArcRoute = {
  id: string;
  provider: string[];
  fromChainId: number;
  toChainId: number;
  fromAmount: string;
  toAmount: string;
  toAmountMin: string;
  feeCosts: ArcFeeCost[];
  gasCosts: ArcGasCost[];
  steps: ArcStep[];
  transactionRequest?: ArcUnsignedTransaction;
  executionDuration?: number | null;
  estimatedCompletionTime?: number | null;
  providerMetadata?: {
    agglayer?: {
      claimTransactionRequired?: boolean;
    };
  };
};

type ArcTransaction = {
  transactionHash: string;
  transactionHashes?: string[];
  status: string;
  sending: {
    txHash: string;
    network: {
      chainId: number;
      networkId: number | null;
    };
  };
  receiving?: {
    txHash?: string | null;
    amount?: string | null;
  } | null;
  metadata?: {
    depositCount?: number | null;
  };
};

type KatanaExecutionState = {
  fromAddress: string;
  claimRequired: boolean;
  claimSubmittedTxHash?: string;
};

export type KatanaBridgeRoute = {
  id: string;
  kind: KatanaDirection;
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  recipient: string;
  approvalAddress?: string;
  executionTx: ArcUnsignedTransaction;
  claimTransactionRequired: boolean;
};

const ARC_API_BASE_URL = 'https://arc-api.polygon.technology';
const DEFAULT_SLIPPAGE = 0.005;
const TRANSACTION_POLL_INTERVAL_MS = 5_000;
const CLAIM_SUBMISSION_TIMEOUT_MS = 10 * 60 * 1_000;
const TRANSACTION_QUERY_LIMIT = 100;
const erc20Interface = new ethers.utils.Interface(ERC20_ABI);

function addressesEqual(a: string, b: string): boolean {
  return normalizeAddressEvm(a) === normalizeAddressEvm(b);
}

function toBigInt(value: string | number | bigint | null | undefined): bigint {
  assert(value !== null && value !== undefined, 'Missing bigint value');
  if (typeof value === 'bigint') return value;
  return BigInt(value);
}

function sumBigIntStrings(values: Array<{ amount: string }>): bigint {
  return values.reduce((sum, value) => sum + BigInt(value.amount), 0n);
}

function normalizeTxHash(txHash: string): string {
  return txHash.startsWith('0x')
    ? txHash.toLowerCase()
    : `0x${txHash.toLowerCase()}`;
}

function txMatchesHash(tx: ArcTransaction, txHash: string): boolean {
  const normalized = normalizeTxHash(txHash);
  return (
    normalizeTxHash(tx.transactionHash) === normalized ||
    normalizeTxHash(tx.sending.txHash) === normalized ||
    tx.transactionHashes?.some(
      (hash) => normalizeTxHash(hash) === normalized,
    ) === true
  );
}

export class KatanaBridge implements IExternalBridge {
  readonly externalBridgeId = 'katana';
  readonly logger: Logger;

  private readonly config: ExternalBridgeConfig;
  private readonly chainMetadataByChainId: Map<number, ChainMetadata>;
  private readonly executionStateByTxHash = new Map<
    string,
    KatanaExecutionState
  >();

  constructor(config: ExternalBridgeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.chainMetadataByChainId = new Map();
    if (config.chainMetadata) {
      for (const metadata of Object.values(config.chainMetadata)) {
        if (
          metadata.chainId !== undefined &&
          metadata.protocol === ProtocolType.Ethereum
        ) {
          this.chainMetadataByChainId.set(Number(metadata.chainId), metadata);
        }
      }
    }
  }

  getNativeTokenAddress(): string {
    return ethers.constants.AddressZero;
  }

  async quote(
    params: BridgeQuoteParams,
  ): Promise<BridgeQuote<KatanaBridgeRoute>> {
    const { fromChain, toChain, fromAmount, toAmount, fromToken, toToken } =
      params;
    const direction = this.getDirection(fromChain, toChain, fromToken, toToken);
    const recipient = normalizeAddressEvm(
      params.toAddress ?? params.fromAddress,
    );
    const slippage =
      params.slippage ?? this.config.defaultSlippage ?? DEFAULT_SLIPPAGE;

    assert(direction, `Unsupported Katana route: ${fromChain} -> ${toChain}`);
    assert(toAmount === undefined, 'KatanaBridge only supports fromAmount');
    assert(fromAmount !== undefined, 'KatanaBridge requires fromAmount');
    assert(fromAmount > 0n, 'KatanaBridge requires a positive fromAmount');

    const routes = await this.requestRoutes({
      fromChainId: fromChain,
      toChainId: toChain,
      fromTokenAddress: normalizeAddressEvm(fromToken),
      toTokenAddress: normalizeAddressEvm(toToken),
      amount: fromAmount.toString(),
      fromAddress: normalizeAddressEvm(params.fromAddress),
      toAddress: recipient,
      slippage: slippage * 100,
    });
    const route = this.selectRoute(routes);
    const executionTx =
      route.transactionRequest ??
      (await this.requestUnsignedTransaction(route));
    const approvalAddress =
      route.steps[0]?.estimate.approvalAddress ?? undefined;

    assert(
      BigInt(route.fromAmount) === fromAmount,
      `Katana route fromAmount ${route.fromAmount} did not match request ${fromAmount}`,
    );

    return {
      id: crypto.randomUUID(),
      tool: 'agglayer',
      fromAmount,
      toAmount: BigInt(route.toAmount),
      toAmountMin: BigInt(route.toAmountMin),
      executionDuration:
        route.estimatedCompletionTime ??
        route.executionDuration ??
        CLAIM_SUBMISSION_TIMEOUT_MS / 1_000,
      gasCosts: sumBigIntStrings(route.gasCosts),
      feeCosts: sumBigIntStrings(
        route.feeCosts.filter((cost) => !cost.included),
      ),
      route: {
        id: route.id,
        kind: direction,
        fromChainId: fromChain,
        toChainId: toChain,
        fromToken: normalizeAddressEvm(fromToken),
        toToken: normalizeAddressEvm(toToken),
        recipient,
        approvalAddress,
        executionTx,
        claimTransactionRequired:
          route.providerMetadata?.agglayer?.claimTransactionRequired === true,
      },
      requestParams: params,
    };
  }

  async execute(
    quote: BridgeQuote<KatanaBridgeRoute>,
    privateKeys: Partial<Record<ProtocolType, string>>,
  ): Promise<BridgeTransferResult> {
    const route = quote.route;
    assert(route, 'KatanaBridge requires a populated route');

    const key = privateKeys[ProtocolType.Ethereum];
    assert(key, 'Missing EVM private key for KatanaBridge execution');

    const signerAddress = normalizeAddressEvm(
      new ethers.Wallet(ensure0x(key)).address,
    );
    this.validateExecutionQuote(quote, route, signerAddress);

    if (route.approvalAddress) {
      const allowance = await this.readAllowance(
        route.executionTx.chainId,
        route.fromToken,
        signerAddress,
        route.approvalAddress,
      );
      if (allowance < quote.fromAmount) {
        await this.sendPreparedTransaction(route.executionTx.chainId, key, {
          to: route.fromToken,
          data: erc20Interface.encodeFunctionData('approve', [
            route.approvalAddress,
            quote.fromAmount.toString(),
          ]),
          value: '0',
          chainId: route.executionTx.chainId,
        });
      }
    }

    const sourceReceipt = await this.sendPreparedTransaction(
      route.executionTx.chainId,
      key,
      route.executionTx,
    );
    const sourceTxHash = normalizeTxHash(sourceReceipt.transactionHash);

    this.executionStateByTxHash.set(sourceTxHash, {
      fromAddress: signerAddress,
      claimRequired: route.claimTransactionRequired,
    });

    if (route.claimTransactionRequired) {
      const claimReceipt = await this.waitForAndSubmitClaim(
        sourceTxHash,
        signerAddress,
        key,
      );
      const state = this.executionStateByTxHash.get(sourceTxHash);
      if (state) {
        state.claimSubmittedTxHash = normalizeTxHash(
          claimReceipt.transactionHash,
        );
      }
    }

    return {
      txHash: sourceTxHash,
      fromChain: route.fromChainId,
      toChain: route.toChainId,
    };
  }

  async getStatus(
    txHash: string,
    _fromChain: number,
    _toChain: number,
  ): Promise<BridgeTransferStatus> {
    const normalizedTxHash = normalizeTxHash(txHash);
    const state = this.executionStateByTxHash.get(normalizedTxHash);
    if (!state) return { status: 'not_found' };

    const tx = await this.findIndexedTransaction(
      state.fromAddress,
      normalizedTxHash,
    );
    if (!tx) {
      return { status: 'pending', substatus: 'INDEXING' };
    }

    if (this.isFailedStatus(tx.status)) {
      return { status: 'failed', error: tx.status };
    }

    const receivingTxHash =
      tx.receiving?.txHash ??
      tx.transactionHashes?.find(
        (hash) => normalizeTxHash(hash) !== normalizedTxHash,
      );

    if (receivingTxHash && tx.receiving?.amount) {
      return {
        status: 'complete',
        receivingTxHash,
        receivedAmount: BigInt(tx.receiving.amount),
      };
    }

    return {
      status: 'pending',
      substatus:
        tx.status === 'BRIDGED' && state.claimSubmittedTxHash
          ? 'CLAIM_SUBMITTED'
          : tx.status,
    };
  }

  protected async requestRoutes(params: {
    fromChainId: number;
    toChainId: number;
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: string;
    fromAddress: string;
    toAddress: string;
    slippage: number;
  }): Promise<ArcRoute[]> {
    const response = await this.fetchArcJson<ArcRoute[]>('/routes', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    return this.requireSuccess(response, 'Failed to fetch Katana routes');
  }

  protected async requestUnsignedTransaction(
    route: ArcRoute,
  ): Promise<ArcUnsignedTransaction> {
    const response = await this.fetchArcJson<ArcUnsignedTransaction>(
      '/routes/build-transaction',
      {
        method: 'POST',
        body: JSON.stringify(route.steps[0]),
      },
    );
    return this.requireSuccess(
      response,
      'Failed to build Katana unsigned transaction',
    );
  }

  protected async requestTransactions(
    address: string,
    limit: number = TRANSACTION_QUERY_LIMIT,
  ): Promise<ArcTransaction[]> {
    const query = new URLSearchParams({
      'transactionsRequestQueryParams[address]': address,
      'transactionsRequestQueryParams[limit]': String(limit),
    });
    const response = await this.fetchArcJson<ArcTransaction[]>(
      `/transactions?${query.toString()}`,
      { method: 'GET' },
    );
    return this.requireSuccess(response, 'Failed to fetch Katana transactions');
  }

  protected async requestClaimTransaction(
    sourceNetworkId: number,
    depositCount: number,
  ): Promise<ArcUnsignedTransaction> {
    const response = await this.fetchArcJson<ArcUnsignedTransaction>(
      '/routes/build-transaction-for-claim',
      {
        method: 'POST',
        body: JSON.stringify({ sourceNetworkId, depositCount }),
      },
    );
    return this.requireSuccess(
      response,
      'Failed to build Katana claim transaction',
    );
  }

  protected getProvider(
    chainId: number,
  ): ethers.providers.StaticJsonRpcProvider {
    return new ethers.providers.StaticJsonRpcProvider(
      this.getRpcUrl(chainId),
      chainId,
    );
  }

  protected async readAllowance(
    chainId: number,
    tokenAddress: string,
    owner: string,
    spender: string,
  ): Promise<bigint> {
    const provider = this.getProvider(chainId);
    const result = await provider.call({
      to: tokenAddress,
      data: erc20Interface.encodeFunctionData('allowance', [owner, spender]),
    });
    return toBigInt(
      erc20Interface.decodeFunctionResult('allowance', result)[0].toString(),
    );
  }

  protected async sendPreparedTransaction(
    chainId: number,
    privateKey: string,
    tx: ArcUnsignedTransaction,
  ): Promise<ethers.providers.TransactionReceipt> {
    const wallet = new ethers.Wallet(
      ensure0x(privateKey),
      this.getProvider(chainId),
    );
    const response = await wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value ? ethers.BigNumber.from(tx.value) : undefined,
      gasLimit: tx.gasLimit ? ethers.BigNumber.from(tx.gasLimit) : undefined,
      gasPrice: tx.gasPrice ? ethers.BigNumber.from(tx.gasPrice) : undefined,
      maxFeePerGas: tx.maxFeePerGas
        ? ethers.BigNumber.from(tx.maxFeePerGas)
        : undefined,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas
        ? ethers.BigNumber.from(tx.maxPriorityFeePerGas)
        : undefined,
    });
    return response.wait();
  }

  protected async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private selectRoute(routes: ArcRoute[]): ArcRoute {
    const route = routes.find((candidate) =>
      candidate.provider.some((provider) => provider === 'agglayer'),
    );
    assert(route, 'No AggLayer route returned for Katana bridge');
    assert(
      route.steps.length > 0,
      `Katana route ${route.id} did not include execution steps`,
    );
    return route;
  }

  private async waitForAndSubmitClaim(
    sourceTxHash: string,
    fromAddress: string,
    privateKey: string,
  ): Promise<ethers.providers.TransactionReceipt> {
    const deadline = Date.now() + CLAIM_SUBMISSION_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const tx = await this.findIndexedTransaction(fromAddress, sourceTxHash);
      if (!tx) {
        await this.sleep(TRANSACTION_POLL_INTERVAL_MS);
        continue;
      }

      if (tx.receiving?.txHash) {
        return {
          transactionHash: tx.receiving.txHash,
        } as ethers.providers.TransactionReceipt;
      }

      const sourceNetworkId = tx.sending.network.networkId;
      const depositCount = tx.metadata?.depositCount;
      if (
        sourceNetworkId === null ||
        depositCount === null ||
        depositCount === undefined
      ) {
        await this.sleep(TRANSACTION_POLL_INTERVAL_MS);
        continue;
      }

      try {
        const claimTx = await this.requestClaimTransaction(
          sourceNetworkId,
          depositCount,
        );
        return this.sendPreparedTransaction(
          claimTx.chainId,
          privateKey,
          claimTx,
        );
      } catch (error) {
        if (this.isClaimNotReadyError(error)) {
          await this.sleep(TRANSACTION_POLL_INTERVAL_MS);
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Timed out waiting for Katana claim for ${sourceTxHash}`);
  }

  private async findIndexedTransaction(
    address: string,
    txHash: string,
  ): Promise<ArcTransaction | undefined> {
    const transactions = await this.requestTransactions(address);
    return transactions.find((tx) => txMatchesHash(tx, txHash));
  }

  private isClaimNotReadyError(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message.toLowerCase().includes('transaction not ready to claim')
    );
  }

  private isFailedStatus(status: string): boolean {
    return ['FAILED', 'ERROR', 'REVERTED'].includes(status.toUpperCase());
  }

  private requireSuccess<T>(response: ArcApiResponse<T>, message: string): T {
    if (response.status === 'success') return response.data;
    throw new Error(`${message}: ${response.message}`);
  }

  private async fetchArcJson<T>(
    path: string,
    init: RequestInit,
    retries: number = 3,
  ): Promise<ArcApiResponse<T>> {
    const url =
      path.startsWith('http://') || path.startsWith('https://')
        ? path
        : `${ARC_API_BASE_URL}${path}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, {
          ...init,
          headers: {
            'content-type': 'application/json',
            ...init.headers,
          },
        });
        const rawBody = await response.text();
        const parsedBody = rawBody
          ? (JSON.parse(rawBody) as ArcApiResponse<T>)
          : ({
              status: 'error',
              message: `HTTP ${response.status}`,
            } as ArcApiResponse<T>);

        if (response.ok) return parsedBody;

        const errorMessage =
          parsedBody.status === 'error'
            ? parsedBody.message
            : `HTTP ${response.status}: ${rawBody}`;
        lastError = new Error(errorMessage);

        if (response.status === 429 || response.status >= 500 || !response.ok) {
          if (attempt < retries) {
            await this.sleep(1_000 * 2 ** attempt);
            continue;
          }
        }

        throw lastError;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < retries) {
          await this.sleep(1_000 * 2 ** attempt);
          continue;
        }
      }
    }

    throw lastError ?? new Error(`Failed to fetch Katana ARC endpoint: ${url}`);
  }

  private getDirection(
    fromChain: number,
    toChain: number,
    fromToken: string,
    toToken: string,
  ): KatanaDirection | undefined {
    if (
      fromChain === ETHEREUM_CHAIN_ID &&
      toChain === KATANA_CHAIN_ID &&
      addressesEqual(fromToken, KATANA_FORWARD_CONFIG.fromToken) &&
      addressesEqual(toToken, KATANA_FORWARD_CONFIG.toToken)
    ) {
      return 'ethereum-to-katana';
    }

    if (
      fromChain === KATANA_CHAIN_ID &&
      toChain === ETHEREUM_CHAIN_ID &&
      addressesEqual(fromToken, KATANA_REVERSE_CONFIG.fromToken) &&
      addressesEqual(toToken, KATANA_REVERSE_CONFIG.toToken)
    ) {
      return 'katana-to-ethereum';
    }

    return undefined;
  }

  private validateExecutionQuote(
    quote: BridgeQuote<KatanaBridgeRoute>,
    route: KatanaBridgeRoute,
    signerAddress: string,
  ): void {
    const expectedDirection = this.getDirection(
      quote.requestParams.fromChain,
      quote.requestParams.toChain,
      quote.requestParams.fromToken,
      quote.requestParams.toToken,
    );

    assert(
      expectedDirection === route.kind,
      'Route kind does not match request',
    );
    assert(
      quote.requestParams.fromAmount === quote.fromAmount,
      'Quote fromAmount does not match request',
    );
    assert(
      addressesEqual(quote.requestParams.fromAddress, signerAddress),
      `Signer ${signerAddress} does not match quote.fromAddress ${quote.requestParams.fromAddress}`,
    );

    const expectedRecipient = normalizeAddressEvm(
      quote.requestParams.toAddress ?? quote.requestParams.fromAddress,
    );
    assert(
      addressesEqual(route.recipient, expectedRecipient),
      `Route recipient ${route.recipient} does not match quote recipient ${expectedRecipient}`,
    );
    assert(
      route.executionTx.chainId === route.fromChainId,
      `Katana execution chain ${route.executionTx.chainId} did not match source chain ${route.fromChainId}`,
    );
  }

  private getRpcUrl(chainId: number): string {
    const metadata = this.chainMetadataByChainId.get(chainId);
    assert(
      metadata,
      `Missing chain metadata for Katana bridge chainId ${chainId}`,
    );
    const rpcUrl = metadata.rpcUrls?.[0]?.http;
    assert(rpcUrl, `Missing RPC URL for Katana bridge chainId ${chainId}`);
    return rpcUrl;
  }
}
