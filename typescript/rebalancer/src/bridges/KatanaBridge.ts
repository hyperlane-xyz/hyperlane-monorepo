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
  applySlippage,
  buildKatanaToEthereumCompose,
  oftInterface,
  previewInterface,
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
  destinationOftAddress?: string;
  destinationStartBlock?: number;
  destinationToken?: string;
  expectedReceivedAmount?: bigint;
  guid?: string;
  kind: KatanaDirection;
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
  destinationOftAddress?: string;
  executionTx: ArcUnsignedTransaction;
  claimTransactionRequired: boolean;
  statusMode: 'arc' | 'oft';
};

const ARC_API_BASE_URL = 'https://arc-api.polygon.technology';
const DEFAULT_SLIPPAGE = 0.005;
const TRANSACTION_POLL_INTERVAL_MS = 5_000;
const CLAIM_SUBMISSION_TIMEOUT_MS = 10 * 60 * 1_000;
const TRANSACTION_QUERY_LIMIT = 100;
// Some Ethereum RPCs enforce an inclusive 50k block log window.
const DESTINATION_LOG_LOOKBACK_BLOCKS = 49_999;
const erc20Interface = new ethers.utils.Interface(ERC20_ABI);
const transferTopic = erc20Interface.getEventTopic('Transfer');
const oftReceivedTopic = oftInterface.getEventTopic('OFTReceived');
const oftSentTopic = oftInterface.getEventTopic('OFTSent');
const composeSentTopic = ethers.utils.id('Sent(bytes32)');

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

    if (direction === 'katana-to-ethereum') {
      return this.quoteKatanaToEthereumOft(
        params,
        recipient,
        fromAmount,
        slippage,
      );
    }

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
        destinationOftAddress: undefined,
        executionTx,
        claimTransactionRequired:
          route.providerMetadata?.agglayer?.claimTransactionRequired === true,
        statusMode: 'arc',
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

    const destinationStartBlock = await this.getCurrentBlockNumber(
      route.toChainId,
    );
    const sourceReceipt = await this.sendPreparedTransaction(
      route.executionTx.chainId,
      key,
      route.executionTx,
    );
    const sourceTxHash = normalizeTxHash(sourceReceipt.transactionHash);

    this.executionStateByTxHash.set(sourceTxHash, {
      fromAddress: signerAddress,
      destinationOftAddress: route.destinationOftAddress,
      destinationStartBlock,
      destinationToken: route.toToken,
      expectedReceivedAmount: quote.toAmountMin,
      guid:
        route.statusMode === 'oft'
          ? this.extractOftGuidFromReceipt(sourceReceipt)
          : undefined,
      claimRequired: route.claimTransactionRequired,
      kind: route.kind,
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
    fromChain: number,
    toChain: number,
  ): Promise<BridgeTransferStatus> {
    const normalizedTxHash = normalizeTxHash(txHash);
    let state = this.executionStateByTxHash.get(normalizedTxHash);
    if (!state) {
      state = await this.rehydrateExecutionState(
        normalizedTxHash,
        fromChain,
        toChain,
      );
      if (state) {
        this.executionStateByTxHash.set(normalizedTxHash, state);
      }
    }
    if (!state) return { status: 'not_found' };

    if (state.kind === 'katana-to-ethereum' && !state.claimRequired) {
      return this.getOftReverseStatus(normalizedTxHash, state);
    }

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

  protected async readContract(
    chainId: number,
    to: string,
    data: string,
  ): Promise<string> {
    return this.getProvider(chainId).call({ to, data });
  }

  protected async getCurrentBlockNumber(chainId: number): Promise<number> {
    return this.getProvider(chainId).getBlockNumber();
  }

  protected async getTransactionReceipt(
    chainId: number,
    txHash: string,
  ): Promise<ethers.providers.TransactionReceipt | null> {
    return this.getProvider(chainId).getTransactionReceipt(txHash);
  }

  protected async getTransaction(
    chainId: number,
    txHash: string,
  ): Promise<ethers.providers.TransactionResponse | null> {
    return this.getProvider(chainId).getTransaction(txHash);
  }

  protected async getLogs(
    chainId: number,
    filter: ethers.providers.Filter,
  ): Promise<ethers.providers.Log[]> {
    return this.getProvider(chainId).getLogs(filter);
  }

  protected async getLatestBlock(
    chainId: number,
  ): Promise<ethers.providers.Block> {
    return this.getProvider(chainId).getBlock('latest');
  }

  protected async getFeeData(
    chainId: number,
  ): Promise<ethers.providers.FeeData> {
    return this.getProvider(chainId).getFeeData();
  }

  protected async resolveFeeOverrides(
    chainId: number,
    tx: ArcUnsignedTransaction,
  ): Promise<
    Pick<
      ethers.providers.TransactionRequest,
      'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'
    >
  > {
    const gasPrice = tx.gasPrice
      ? ethers.BigNumber.from(tx.gasPrice)
      : undefined;
    const maxFeePerGas = tx.maxFeePerGas
      ? ethers.BigNumber.from(tx.maxFeePerGas)
      : undefined;
    const maxPriorityFeePerGas = tx.maxPriorityFeePerGas
      ? ethers.BigNumber.from(tx.maxPriorityFeePerGas)
      : undefined;
    const latestBlock = await this.getLatestBlock(chainId);
    const baseFeePerGas = latestBlock.baseFeePerGas;

    if (
      baseFeePerGas &&
      ((gasPrice && gasPrice.lt(baseFeePerGas)) ||
        (maxFeePerGas && maxFeePerGas.lt(baseFeePerGas)))
    ) {
      const feeData = await this.getFeeData(chainId);
      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        return {
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        };
      }
      if (feeData.gasPrice) {
        return {
          gasPrice: feeData.gasPrice,
        };
      }
    }

    return {
      gasPrice,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
  }

  protected async sendPreparedTransaction(
    chainId: number,
    privateKey: string,
    tx: ArcUnsignedTransaction,
  ): Promise<ethers.providers.TransactionReceipt> {
    const feeOverrides = await this.resolveFeeOverrides(chainId, tx);
    const wallet = new ethers.Wallet(
      ensure0x(privateKey),
      this.getProvider(chainId),
    );
    const response = await wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value ? ethers.BigNumber.from(tx.value) : undefined,
      gasLimit: tx.gasLimit ? ethers.BigNumber.from(tx.gasLimit) : undefined,
      ...feeOverrides,
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

  private async quoteKatanaToEthereumOft(
    params: BridgeQuoteParams,
    recipient: string,
    fromAmount: bigint,
    slippage: number,
  ): Promise<BridgeQuote<KatanaBridgeRoute>> {
    const previewData = await this.readContract(
      ETHEREUM_CHAIN_ID,
      KATANA_REVERSE_CONFIG.vaultAddress,
      previewInterface.encodeFunctionData('previewRedeem', [
        fromAmount.toString(),
      ]),
    );
    const previewResult = previewInterface.decodeFunctionResult(
      'previewRedeem',
      previewData,
    );
    const assetAmount = toBigInt(previewResult[0].toString());
    const minAssetAmount = applySlippage(assetAmount, slippage);

    const built = buildKatanaToEthereumCompose({
      ...KATANA_REVERSE_CONFIG,
      recipient,
      refundAddress: params.fromAddress,
      shareAmountLD: fromAmount,
      minShareAmountLD: fromAmount,
      assetAmountLD: assetAmount,
      minAssetAmountLD: minAssetAmount,
    });

    const quoteData = await this.readContract(
      KATANA_CHAIN_ID,
      built.quoteRead.to,
      built.quoteRead.data,
    );
    const quoteResult = oftInterface.decodeFunctionResult(
      'quoteSend',
      quoteData,
    );
    const nativeFee = toBigInt(quoteResult[0].nativeFee.toString());
    const lzTokenFee = toBigInt(quoteResult[0].lzTokenFee.toString());
    assert(lzTokenFee === 0n, 'Katana OFT unexpectedly required lzTokenFee');

    return {
      id: crypto.randomUUID(),
      tool: 'oft',
      fromAmount,
      toAmount: assetAmount,
      toAmountMin: minAssetAmount,
      executionDuration: CLAIM_SUBMISSION_TIMEOUT_MS / 1_000,
      gasCosts: nativeFee,
      feeCosts: 0n,
      route: {
        id: crypto.randomUUID(),
        kind: 'katana-to-ethereum',
        fromChainId: KATANA_CHAIN_ID,
        toChainId: ETHEREUM_CHAIN_ID,
        fromToken: normalizeAddressEvm(params.fromToken),
        toToken: normalizeAddressEvm(params.toToken),
        recipient,
        approvalAddress: built.shareApproveTx.spender,
        destinationOftAddress: KATANA_FORWARD_CONFIG.shareOftAddress,
        executionTx: this.buildOftExecutionTx(built.sendTx, nativeFee),
        claimTransactionRequired: false,
        statusMode: 'oft',
      },
      requestParams: params,
    };
  }

  private buildOftExecutionTx(
    tx: { to: string; data: string },
    nativeFee: bigint,
  ): ArcUnsignedTransaction {
    const decoded = oftInterface.decodeFunctionData('send', tx.data);
    return {
      to: tx.to,
      data: oftInterface.encodeFunctionData('send', [
        decoded.sendParam,
        { nativeFee: nativeFee.toString(), lzTokenFee: '0' },
        decoded.refundAddress,
      ]),
      value: nativeFee.toString(),
      chainId: KATANA_CHAIN_ID,
    };
  }

  private extractOftGuidFromReceipt(
    receipt: ethers.providers.TransactionReceipt,
  ): string | undefined {
    for (const log of receipt.logs) {
      if (log.topics[0] !== oftSentTopic) continue;
      const parsed = oftInterface.parseLog(log);
      return ensure0x(parsed.args.guid);
    }
    return undefined;
  }

  private async getOftReverseStatus(
    txHash: string,
    state: KatanaExecutionState,
  ): Promise<BridgeTransferStatus> {
    assert(state.destinationOftAddress, 'Missing destination OFT address');
    assert(state.destinationToken, 'Missing destination token');

    const sourceReceipt = await this.getTransactionReceipt(
      KATANA_CHAIN_ID,
      txHash,
    );
    if (!sourceReceipt) {
      return { status: 'pending', substatus: 'SOURCE_PENDING' };
    }

    const guid = state.guid ?? this.extractOftGuidFromReceipt(sourceReceipt);
    if (!guid) {
      return { status: 'pending', substatus: 'GUID_PENDING' };
    }

    const destinationLogs = await this.getLogs(ETHEREUM_CHAIN_ID, {
      address: state.destinationOftAddress,
      fromBlock: state.destinationStartBlock ?? 0,
      toBlock: 'latest',
      topics: [oftReceivedTopic, guid],
    });

    if (!destinationLogs.length) {
      return { status: 'pending', substatus: 'OFT_IN_FLIGHT' };
    }

    const receivingTxHash = normalizeTxHash(destinationLogs[0].transactionHash);
    const destinationReceipt = await this.getTransactionReceipt(
      ETHEREUM_CHAIN_ID,
      receivingTxHash,
    );
    if (!destinationReceipt) {
      return { status: 'pending', substatus: 'DESTINATION_PENDING' };
    }

    const receivedAmount = this.extractReceivedTokenAmount(
      destinationReceipt,
      state.destinationToken,
      state.fromAddress,
    );
    if (receivedAmount > 0n) {
      return {
        status: 'complete',
        receivingTxHash,
        receivedAmount,
      };
    }

    const composeLogs = await this.getLogs(ETHEREUM_CHAIN_ID, {
      address: KATANA_REVERSE_CONFIG.composerAddress,
      fromBlock: destinationReceipt.blockNumber,
      toBlock: 'latest',
      topics: [composeSentTopic, guid],
    });
    if (!composeLogs.length) {
      return { status: 'pending', substatus: 'OFT_RECEIVED' };
    }

    const composeTxHash = normalizeTxHash(composeLogs[0].transactionHash);
    const composeReceipt = await this.getTransactionReceipt(
      ETHEREUM_CHAIN_ID,
      composeTxHash,
    );
    if (!composeReceipt) {
      return { status: 'pending', substatus: 'COMPOSE_PENDING' };
    }

    const composedAmount = this.extractReceivedTokenAmount(
      composeReceipt,
      state.destinationToken,
      state.fromAddress,
    );
    if (composedAmount === 0n) {
      return { status: 'pending', substatus: 'COMPOSE_RECEIVED' };
    }

    return {
      status: 'complete',
      receivingTxHash: composeTxHash,
      receivedAmount: composedAmount,
    };
  }

  private async rehydrateExecutionState(
    txHash: string,
    fromChain: number,
    toChain: number,
  ): Promise<KatanaExecutionState | undefined> {
    const transaction = await this.getTransaction(fromChain, txHash);
    if (!transaction?.from) return undefined;

    const fromAddress = normalizeAddressEvm(transaction.from);
    const sourceReceipt = await this.getTransactionReceipt(fromChain, txHash);
    const guid = sourceReceipt
      ? this.extractOftGuidFromReceipt(sourceReceipt)
      : undefined;

    if (fromChain === KATANA_CHAIN_ID && toChain === ETHEREUM_CHAIN_ID) {
      const latestDestinationBlock =
        await this.getCurrentBlockNumber(ETHEREUM_CHAIN_ID);
      return {
        fromAddress,
        claimRequired: false,
        destinationOftAddress: KATANA_FORWARD_CONFIG.shareOftAddress,
        destinationStartBlock: Math.max(
          latestDestinationBlock - DESTINATION_LOG_LOOKBACK_BLOCKS,
          0,
        ),
        destinationToken: KATANA_REVERSE_CONFIG.toToken,
        guid,
        kind: 'katana-to-ethereum',
      };
    }

    if (fromChain === ETHEREUM_CHAIN_ID && toChain === KATANA_CHAIN_ID) {
      return {
        fromAddress,
        claimRequired: false,
        kind: 'ethereum-to-katana',
      };
    }

    return undefined;
  }

  private extractReceivedTokenAmount(
    receipt: ethers.providers.TransactionReceipt,
    tokenAddress: string,
    recipient: string,
  ): bigint {
    const recipientTopic = ethers.utils
      .hexZeroPad(normalizeAddressEvm(recipient), 32)
      .toLowerCase();

    return receipt.logs.reduce((sum, log) => {
      if (!addressesEqual(log.address, tokenAddress)) return sum;
      if (
        log.topics[0] !== transferTopic ||
        log.topics[2]?.toLowerCase() !== recipientTopic
      ) {
        return sum;
      }
      return sum + toBigInt(log.data);
    }, 0n);
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
