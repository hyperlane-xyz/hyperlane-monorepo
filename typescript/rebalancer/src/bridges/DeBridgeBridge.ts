import { ethers } from 'ethers';

import type { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';
import type { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';

import type {
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import {
  DEBRIDGE_API_BASE,
  DEBRIDGE_STATUS_API,
  DEBRIDGE_TOOL,
  formatAddressForDebridge,
  hyperlaneChainIdToDebridge,
  isDebridgeTronChain,
  type DeBridgeCreateTxResponse,
  type DeBridgeOrderStatusResponse,
  type DeBridgeQuoteResponse,
} from './deBridgeUtils.js';

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;

type TronWebLike = {
  trx: {
    getTransactionInfo: (txId: string) => Promise<{
      receipt?: { result?: string };
    }>;
    sign: (tx: unknown) => Promise<{ txID: string }>;
    sendRawTransaction: (signed: unknown) => Promise<{ result?: boolean }>;
  };
  address: {
    fromPrivateKey: (privateKey: string) => string;
    toHex: (address: string) => string;
  };
  transactionBuilder: {
    triggerSmartContract: (
      contractAddress: string,
      functionSelector: string,
      options: { callValue: number; feeLimit: number },
      parameters: Array<{ type: string; value: unknown }>,
      issuerAddress: string,
    ) => Promise<{ transaction?: { txID: string } }>;
  };
};

export class DeBridgeBridge implements IExternalBridge {
  readonly externalBridgeId = DEBRIDGE_TOOL;
  readonly logger: Logger;
  private readonly apiUrl: string;
  private readonly chainMetadataByChainId: Map<number, ChainMetadata>;
  private readonly txHashToOrderId = new Map<string, string>();

  constructor(
    config: { apiUrl?: string; chainMetadata?: ChainMap<ChainMetadata> },
    logger: Logger,
  ) {
    this.logger = logger;
    this.apiUrl = config.apiUrl ?? DEBRIDGE_API_BASE;
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

  async quote(params: BridgeQuoteParams): Promise<BridgeQuote> {
    const { fromChain, toChain, fromToken, toToken, fromAmount, toAmount } =
      params;

    assert(
      !(fromAmount !== undefined && toAmount !== undefined),
      'Cannot specify both fromAmount and toAmount',
    );
    assert(
      fromAmount !== undefined || toAmount !== undefined,
      'Must specify either fromAmount or toAmount',
    );

    const srcDebridgeChainId = hyperlaneChainIdToDebridge(fromChain);
    const dstDebridgeChainId = hyperlaneChainIdToDebridge(toChain);

    const srcToken = formatAddressForDebridge(fromToken, srcDebridgeChainId);
    const dstToken = formatAddressForDebridge(toToken, dstDebridgeChainId);

    const amountStr = (fromAmount ?? toAmount!).toString();

    const url =
      `${this.apiUrl}/dln/order/quote` +
      `?srcChainId=${srcDebridgeChainId}` +
      `&srcChainTokenIn=${srcToken}` +
      `&srcChainTokenInAmount=${amountStr}` +
      `&dstChainId=${dstDebridgeChainId}` +
      `&dstChainTokenOut=${dstToken}` +
      `&prependOperatingExpenses=true`;

    this.logger.debug(
      { fromChain, toChain, srcDebridgeChainId, dstDebridgeChainId },
      'Requesting deBridge quote',
    );

    const response = await this.fetchWithRetry(url);
    const data: DeBridgeQuoteResponse = await response.json();

    assert(
      data.estimation,
      `deBridge quote failed: ${data.errorMessage ?? 'no estimation returned'}`,
    );

    const receivedAmount = BigInt(data.estimation.dstChainTokenOut.amount);
    const feeCosts =
      BigInt(data.fixFee ?? '0') + BigInt(data.protocolFee ?? '0');

    return {
      id: uuidv4(),
      tool: DEBRIDGE_TOOL,
      fromAmount:
        params.fromAmount ?? BigInt(data.estimation.srcChainTokenIn.amount),
      toAmount: receivedAmount,
      // deBridge guarantees exact output amounts for stablecoins
      toAmountMin: receivedAmount,
      executionDuration: 60,
      // Gas included in operating expenses via prependOperatingExpenses=true
      gasCosts: 0n,
      feeCosts,
      route: data,
      requestParams: { ...params },
    };
  }

  async execute(
    quote: BridgeQuote<DeBridgeQuoteResponse>,
    privateKeys: Partial<Record<ProtocolType, string>>,
  ): Promise<BridgeTransferResult> {
    const { requestParams: params } = quote;
    const srcDebridgeChainId = hyperlaneChainIdToDebridge(params.fromChain);
    const dstDebridgeChainId = hyperlaneChainIdToDebridge(params.toChain);
    const isTronSource = isDebridgeTronChain(srcDebridgeChainId);
    const isTronDest = isDebridgeTronChain(dstDebridgeChainId);

    let senderAddress: string;
    if (isTronSource) {
      const tronKey = privateKeys['tron' as ProtocolType];
      assert(tronKey, 'Missing private key for Tron chain');
      const { TronWeb } = await import('tronweb');
      const strippedKey = tronKey.replace(/^0x/, '');
      const tw = new TronWeb({
        fullHost: 'https://api.trongrid.io',
        privateKey: strippedKey,
      }) as unknown as TronWebLike;
      senderAddress = tw.address.fromPrivateKey(strippedKey);
    } else {
      const evmKey = privateKeys[ProtocolType.Ethereum];
      assert(evmKey, 'Missing private key for EVM chain');
      senderAddress = new ethers.Wallet(evmKey).address;
    }

    let recipientAddress: string;
    if (params.toAddress) {
      recipientAddress = params.toAddress;
    } else if (isTronDest && !isTronSource) {
      assert(
        params.toAddress,
        'toAddress is required when bridging to Tron from a non-Tron chain',
      );
      recipientAddress = params.toAddress;
    } else {
      recipientAddress = senderAddress;
    }

    const srcSender = formatAddressForDebridge(
      senderAddress,
      srcDebridgeChainId,
    );
    const dstRecipient = formatAddressForDebridge(
      recipientAddress,
      dstDebridgeChainId,
    );

    const srcToken = formatAddressForDebridge(
      params.fromToken,
      srcDebridgeChainId,
    );
    const dstToken = formatAddressForDebridge(
      params.toToken,
      dstDebridgeChainId,
    );
    const amountStr = (params.fromAmount ?? quote.fromAmount).toString();

    const createTxUrl =
      `${this.apiUrl}/dln/order/create-tx` +
      `?srcChainId=${srcDebridgeChainId}` +
      `&srcChainTokenIn=${srcToken}` +
      `&srcChainTokenInAmount=${amountStr}` +
      `&dstChainId=${dstDebridgeChainId}` +
      `&dstChainTokenOut=${dstToken}` +
      `&dstChainTokenOutRecipient=${dstRecipient}` +
      `&srcChainOrderAuthorityAddress=${srcSender}` +
      `&dstChainOrderAuthorityAddress=${dstRecipient}` +
      `&prependOperatingExpenses=true`;

    this.logger.info(
      {
        fromChain: params.fromChain,
        toChain: params.toChain,
        amount: amountStr,
        sender: srcSender,
        recipient: dstRecipient,
      },
      'Creating deBridge order transaction',
    );

    const createTxResponse = await this.fetchWithRetry(createTxUrl);
    const createTxData: DeBridgeCreateTxResponse =
      await createTxResponse.json();

    assert(
      createTxData.tx,
      `deBridge create-tx failed: ${createTxData.errorMessage ?? 'no tx returned'}`,
    );

    const { to, data: txData, value: txValue } = createTxData.tx;
    const orderId = createTxData.orderId;

    if (isTronSource) {
      return this.executeTron(
        privateKeys,
        to,
        txData,
        txValue,
        orderId,
        params.fromChain,
        params.toChain,
      );
    }

    return this.executeEvm(
      privateKeys,
      to,
      txData,
      txValue,
      orderId,
      params.fromChain,
      params.toChain,
      params.fromToken,
      quote.fromAmount,
    );
  }

  async getStatus(
    txHash: string,
    _fromChain: number,
    _toChain: number,
  ): Promise<BridgeTransferStatus> {
    const orderId = this.txHashToOrderId.get(txHash) ?? txHash;
    const url = `${DEBRIDGE_STATUS_API}/dln/order/${orderId}/status`;

    this.logger.debug({ orderId }, 'Checking deBridge order status');

    try {
      const response = await this.fetchWithRetry(url);
      const data: DeBridgeOrderStatusResponse = await response.json();

      if (data.errorCode || data.errorMessage) {
        this.logger.warn(
          {
            orderId,
            errorCode: data.errorCode,
            errorMessage: data.errorMessage,
          },
          'deBridge status API error',
        );
        return { status: 'not_found' };
      }

      switch (data.status) {
        case 'Fulfilled':
        case 'ClaimedUnlock':
          return {
            status: 'complete',
            receivingTxHash:
              data.fulfilledDstEventMetadata?.transactionHash?.stringValue ??
              '',
            receivedAmount: BigInt(
              data.fulfilledDstEventMetadata?.receivedAmount?.bigIntegerValue ??
                '0',
            ),
          };
        case 'Created':
        case 'SentUnlock':
          return { status: 'pending', substatus: data.status };
        case 'Cancelled':
          return { status: 'failed', error: 'Order cancelled' };
        default:
          return {
            status: 'pending',
            substatus: data.status ?? 'unknown',
          };
      }
    } catch (error) {
      this.logger.error(
        { orderId, error },
        'Failed to fetch deBridge order status',
      );
      return { status: 'not_found' };
    }
  }

  private async executeEvm(
    privateKeys: Partial<Record<ProtocolType, string>>,
    to: string,
    data: string,
    value: string,
    orderId: string | undefined,
    fromChain: number,
    toChain: number,
    tokenAddress?: string,
    amount?: bigint,
  ): Promise<BridgeTransferResult> {
    const evmKey = privateKeys[ProtocolType.Ethereum];
    assert(evmKey, 'Missing private key for EVM chain');

    const rpcUrl = this.getRpcUrl(fromChain);
    const provider = new ethers.providers.StaticJsonRpcProvider(
      rpcUrl,
      fromChain,
    );
    const wallet = new ethers.Wallet(evmKey, provider);

    // Approve DlnSource contract to spend source token if needed
    if (
      tokenAddress &&
      tokenAddress !== ethers.constants.AddressZero &&
      amount
    ) {
      const erc20 = new ethers.Contract(
        tokenAddress,
        [
          'function allowance(address,address) view returns (uint256)',
          'function approve(address,uint256) returns (bool)',
        ],
        wallet,
      );
      const currentAllowance: ethers.BigNumber = await erc20.allowance(
        wallet.address,
        to,
      );
      if (currentAllowance.lt(amount.toString())) {
        this.logger.info(
          { token: tokenAddress, spender: to, amount: amount.toString() },
          'Approving token for deBridge DlnSource contract',
        );
        const approveTx = await erc20.approve(to, ethers.constants.MaxUint256);
        await approveTx.wait();
        this.logger.info(
          { token: tokenAddress, spender: to, txHash: approveTx.hash },
          'Token approval confirmed',
        );
      }
    }

    this.logger.info(
      { from: wallet.address, to, fromChain },
      'Sending deBridge EVM transaction',
    );

    const tx = await wallet.sendTransaction({
      to,
      data,
      value: BigInt(value),
    });
    await tx.wait();

    this.logger.info(
      { txHash: tx.hash, orderId },
      'deBridge EVM transaction confirmed',
    );

    if (orderId) {
      this.txHashToOrderId.set(tx.hash, orderId);
    }

    return {
      txHash: tx.hash,
      fromChain,
      toChain,
      transferId: orderId,
    };
  }

  private async executeTron(
    privateKeys: Partial<Record<ProtocolType, string>>,
    to: string,
    data: string,
    value: string,
    orderId: string | undefined,
    fromChain: number,
    toChain: number,
  ): Promise<BridgeTransferResult> {
    const tronKey = privateKeys['tron' as ProtocolType];
    assert(tronKey, 'Missing private key for Tron chain');

    const { TronWeb } = await import('tronweb');
    const strippedKey = tronKey.replace(/^0x/, '');
    const rpcUrl = this.getRpcUrl(fromChain);
    const tronWeb = new TronWeb({
      fullHost: rpcUrl,
      privateKey: strippedKey,
    }) as unknown as TronWebLike;
    const signerAddress = tronWeb.address.fromPrivateKey(strippedKey);
    // deBridge provides raw ABI calldata in tx.data.
    // Extract function selector (first 4 bytes) and pass remaining bytes
    // as hex parameter to triggerSmartContract.
    // Note: This path is for Tron as source chain (less common than EVM source).
    // The data field from deBridge is EVM ABI-encoded calldata.
    const functionSelector = data.slice(2, 10); // first 4 bytes (8 hex chars after 0x)
    const hexParams = data.slice(10); // remaining calldata
    const callValue = Number(BigInt(value));

    this.logger.info(
      { sender: signerAddress, to, fromChain, orderId, functionSelector },
      'Sending deBridge Tron transaction',
    );

    const triggerResult = await tronWeb.transactionBuilder.triggerSmartContract(
      to,
      `0x${functionSelector}`,
      { callValue, feeLimit: 500_000_000 },
      [{ type: 'bytes', value: hexParams }],
      signerAddress,
    );

    assert(triggerResult.transaction, 'Tron transaction build failed');

    // Inject the raw calldata from deBridge API into the built transaction
    const rawTx = triggerResult.transaction as Record<string, unknown>;
    const rawData = (rawTx.raw_data as Record<string, unknown>) ?? {};
    rawTx.raw_data = { ...rawData, data };

    const signedTx = await tronWeb.trx.sign(rawTx);
    await tronWeb.trx.sendRawTransaction(signedTx);
    await this.waitForTronTx(tronWeb, signedTx.txID);

    this.logger.info(
      { txHash: signedTx.txID, orderId },
      'deBridge Tron transaction confirmed',
    );

    return {
      txHash: signedTx.txID,
      fromChain,
      toChain,
      transferId: orderId,
    };
  }

  private async waitForTronTx(
    tronWeb: TronWebLike,
    txId: string,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < TIMEOUT_MS) {
      const info = await tronWeb.trx.getTransactionInfo(txId);
      const result = info?.receipt?.result;

      if (result === 'FAILED') {
        throw new Error(`Tron transaction failed: ${txId}`);
      }
      if (result === 'SUCCESS') {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`Tron transaction timed out: ${txId}`);
  }

  private async fetchWithRetry(
    url: string,
    options?: RequestInit,
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, BASE_BACKOFF_MS * Math.pow(2, attempt - 1)),
        );
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          const body = await response.text();
          throw new Error(`HTTP ${response.status}: ${body}`);
        }

        if (response.ok) return response;
        lastError = new Error(`HTTP ${response.status} from ${url}`);
      } catch (err) {
        if (err instanceof Error && /^HTTP 4\d\d/.test(err.message)) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError ?? new Error(`fetchWithRetry exhausted retries for ${url}`);
  }

  private getRpcUrl(chainId: number): string {
    const rpcUrl = this.chainMetadataByChainId.get(chainId)?.rpcUrls?.[0]?.http;
    assert(rpcUrl, `No RPC URL configured for chain ${chainId}`);
    return rpcUrl;
  }
}
