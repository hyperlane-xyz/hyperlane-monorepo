import { ethers } from 'ethers';
import { TronWeb } from 'tronweb';

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

export class DeBridgeBridge implements IExternalBridge {
  readonly externalBridgeId = DEBRIDGE_TOOL;
  readonly logger: Logger;
  private readonly apiUrl: string;
  private readonly chainMetadataByChainId: Map<number, ChainMetadata>;
  private readonly txHashToOrderId = new Map<string, string>();
  private readonly maxFeePercent: number;

  constructor(
    config: {
      apiUrl?: string;
      chainMetadata?: ChainMap<ChainMetadata>;
      maxFeePercent?: number;
    },
    logger: Logger,
  ) {
    this.logger = logger;
    this.apiUrl = config.apiUrl ?? DEBRIDGE_API_BASE;
    this.maxFeePercent = config.maxFeePercent ?? 10;
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
      `&dstChainTokenOutAmount=auto` +
      `&prependOperatingExpenses=false`;

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

    const srcAmount = BigInt(data.estimation.srcChainTokenIn.amount);
    const receivedAmount = BigInt(data.estimation.dstChainTokenOut.amount);

    // Fee guard: reject uneconomical bridges
    const feeAmount = srcAmount - receivedAmount;
    const feePercent =
      srcAmount > 0n ? Number((feeAmount * 10000n) / srcAmount) / 100 : 0;
    this.logger.info(
      {
        fromChain,
        toChain,
        feePercent: feePercent.toFixed(1),
        feeAmount: feeAmount.toString(),
        srcAmount: srcAmount.toString(),
      },
      'deBridge fee breakdown',
    );
    if (feePercent > this.maxFeePercent) {
      throw new Error(
        `deBridge fee too high: ${feePercent.toFixed(1)}% (${feeAmount} of ${srcAmount}). Max allowed: ${this.maxFeePercent}%`,
      );
    }

    const feeCosts =
      BigInt(data.fixFee ?? '0') + BigInt(data.protocolFee ?? '0');

    return {
      id: uuidv4(),
      tool: DEBRIDGE_TOOL,
      fromAmount: srcAmount,
      toAmount: receivedAmount,
      toAmountMin: receivedAmount,
      executionDuration: 60,
      // prependOperatingExpenses=false: fee taken from spread, not added to source
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

    const sourceProtocol = isTronSource
      ? ('tron' as ProtocolType)
      : ProtocolType.Ethereum;

    let senderAddress: string;
    switch (sourceProtocol) {
      case 'tron' as ProtocolType: {
        const tronKey = privateKeys['tron' as ProtocolType];
        assert(tronKey, 'Missing private key for Tron chain');
        const strippedKey = tronKey.replace(/^0x/, '');
        const tw = new TronWeb({
          fullHost: 'https://api.trongrid.io',
          privateKey: strippedKey,
        });
        const derived = tw.address.fromPrivateKey(strippedKey);
        assert(derived, 'Failed to derive Tron address from private key');
        senderAddress = derived as string;
        break;
      }
      case ProtocolType.Ethereum: {
        const evmKey = privateKeys[ProtocolType.Ethereum];
        assert(evmKey, 'Missing private key for EVM chain');
        senderAddress = new ethers.Wallet(evmKey).address;
        break;
      }
      default:
        throw new Error(`Unsupported source protocol: ${sourceProtocol}`);
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
      `&dstChainTokenOutAmount=auto` +
      `&prependOperatingExpenses=false`;

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

    switch (sourceProtocol) {
      case 'tron' as ProtocolType:
        return this.executeTron(
          privateKeys,
          to,
          txData,
          txValue,
          orderId,
          params.fromChain,
          params.toChain,
        );
      case ProtocolType.Ethereum:
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
      default:
        throw new Error(`Unsupported source protocol: ${sourceProtocol}`);
    }
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
        // USDT requires allowance to be reset to 0 before setting a new non-zero value
        if (currentAllowance.gt(0)) {
          this.logger.info(
            { token: tokenAddress, spender: to },
            'Resetting token allowance to 0 (required by USDT)',
          );
          const resetTx = await erc20.approve(to, 0);
          await resetTx.wait();
        }
        const approveAmount = amount;
        this.logger.info(
          {
            token: tokenAddress,
            spender: to,
            amount: approveAmount.toString(),
          },
          'Approving exact amount for deBridge DlnSource contract',
        );
        const approveTx = await erc20.approve(to, approveAmount.toString());
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

    const strippedKey = tronKey.replace(/^0x/, '');
    const rpcUrl = this.getRpcUrl(fromChain);
    const tronWeb = new TronWeb({
      fullHost: rpcUrl,
      privateKey: strippedKey,
    });
    const signerAddress = tronWeb.address.fromPrivateKey(strippedKey);
    assert(signerAddress, 'Failed to derive Tron address from private key');

    // deBridge provides raw ABI calldata in tx.data.
    // Extract function selector (first 4 bytes) and pass remaining bytes
    // as hex parameter to triggerSmartContract.
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
      signerAddress as string,
    );

    assert(triggerResult.transaction, 'Tron transaction build failed');

    // Inject the raw calldata from deBridge API into the built transaction
    const rawTx = triggerResult.transaction as unknown as Record<
      string,
      unknown
    >;
    const rawData = (rawTx.raw_data as Record<string, unknown>) ?? {};
    rawTx.raw_data = { ...rawData, data };

    const signedTx = await tronWeb.trx.sign(
      rawTx as unknown as Parameters<typeof tronWeb.trx.sign>[0],
    );
    assert(typeof signedTx !== 'string', 'Unexpected string from trx.sign');
    await tronWeb.trx.sendRawTransaction(
      signedTx as Parameters<typeof tronWeb.trx.sendRawTransaction>[0],
    );
    const txId = (signedTx as { txID: string }).txID;
    await this.waitForTronTx(tronWeb, txId);

    this.logger.info(
      { txHash: txId, orderId },
      'deBridge Tron transaction confirmed',
    );

    return {
      txHash: txId,
      fromChain,
      toChain,
      transferId: orderId,
    };
  }

  private async waitForTronTx(tronWeb: TronWeb, txId: string): Promise<void> {
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
