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
  MESON_API_BASE,
  evmChainIdToMesonChain,
  toMesonTokenId,
  type MesonEncodeResponse,
  type MesonPriceResponse,
  type MesonStatusResponse,
  type MesonSwapResponse,
} from './mesonUtils.js';

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const MESON_SOFT_LIMIT_USDT = 20_000n * 1_000_000n;
const MESON_TOOL = 'meson';
const USDT_SYMBOL = 'USDT';

class NonRetryableHttpError extends Error {}

export class MesonBridge implements IExternalBridge {
  readonly externalBridgeId = MESON_TOOL;
  readonly logger: Logger;
  private readonly apiUrl: string;
  private readonly defaultSlippage: number;

  constructor(
    config: {
      apiUrl?: string;
      defaultSlippage?: number;
      chainMetadata?: ChainMap<ChainMetadata>;
    },
    logger: Logger,
  ) {
    this.logger = logger;
    this.apiUrl = config.apiUrl ?? MESON_API_BASE;
    this.defaultSlippage = config.defaultSlippage ?? 0;
    void config.chainMetadata;
  }

  async quote(
    params: BridgeQuoteParams,
  ): Promise<BridgeQuote<MesonPriceResponse>> {
    const hasFromAmount = params.fromAmount !== undefined;
    const hasToAmount = params.toAmount !== undefined;
    assert(
      hasFromAmount !== hasToAmount,
      'Must specify exactly one of fromAmount or toAmount',
    );
    assert(
      params.fromAmount === undefined || params.fromAmount > 0n,
      'fromAmount must be positive',
    );
    assert(
      params.toAmount === undefined || params.toAmount > 0n,
      'toAmount must be positive',
    );

    const amountValue = params.fromAmount ?? params.toAmount!;
    const from = toMesonTokenId(
      evmChainIdToMesonChain(params.fromChain),
      USDT_SYMBOL,
    );
    const to = toMesonTokenId(
      evmChainIdToMesonChain(params.toChain),
      USDT_SYMBOL,
    );

    if (amountValue > MESON_SOFT_LIMIT_USDT) {
      this.logger.warn(
        {
          fromChain: params.fromChain,
          toChain: params.toChain,
          from,
          to,
          amount: amountValue.toString(),
          limit: MESON_SOFT_LIMIT_USDT.toString(),
        },
        'Meson quote amount exceeds soft 20k USDT limit',
      );
    }

    const mode = params.fromAmount !== undefined ? 'fromAmount' : 'toAmount';
    this.logger.debug(
      {
        mode,
        fromChain: params.fromChain,
        toChain: params.toChain,
        from,
        to,
        amount: amountValue.toString(),
        slippage: params.slippage ?? this.defaultSlippage,
      },
      'Requesting Meson quote',
    );

    const response = await this.fetchWithRetry(`${this.apiUrl}/price`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to,
        amount: amountValue.toString(),
      }),
    });
    const data = (await response.json()) as MesonPriceResponse;
    if (data.error) {
      throw new Error(
        `Meson price error: ${data.error.code} ${data.error.message}`,
      );
    }
    assert(data.result, 'Meson /price missing result');

    const feeCosts = this.parseMesonAmount(data.result.totalFee);
    const toAmount = amountValue > feeCosts ? amountValue - feeCosts : 0n;
    const quoteId = uuidv4();

    this.logger.info(
      {
        quoteId,
        mode,
        fromAmount: amountValue.toString(),
        toAmount: toAmount.toString(),
        feeCosts: feeCosts.toString(),
      },
      'Meson quote received',
    );

    return {
      id: quoteId,
      tool: MESON_TOOL,
      fromAmount: amountValue,
      toAmount,
      toAmountMin: toAmount,
      executionDuration: 300,
      gasCosts: 0n,
      feeCosts,
      route: data,
      requestParams: { ...params },
    };
  }

  async execute(
    quote: BridgeQuote<MesonPriceResponse>,
    privateKeys: Partial<Record<ProtocolType, string>>,
  ): Promise<BridgeTransferResult> {
    const privateKey = privateKeys[ProtocolType.Ethereum];
    assert(privateKey, 'Missing private key for ProtocolType.Ethereum');

    const wallet = new ethers.Wallet(privateKey);
    const amountValue =
      quote.requestParams.fromAmount ?? quote.requestParams.toAmount;
    assert(amountValue, 'Meson execute missing amount in request params');
    const from = toMesonTokenId(
      evmChainIdToMesonChain(quote.requestParams.fromChain),
      USDT_SYMBOL,
    );
    const to = toMesonTokenId(
      evmChainIdToMesonChain(quote.requestParams.toChain),
      USDT_SYMBOL,
    );
    const fromAddress = wallet.address;
    const recipient =
      quote.requestParams.toAddress ?? quote.requestParams.fromAddress;
    assert(recipient, 'Meson execute missing recipient');

    this.logger.info(
      { quoteId: quote.id, fromAddress, recipient, from, to, amountValue },
      'Encoding Meson swap',
    );

    const encodeResponse = await this.fetchWithRetry(`${this.apiUrl}/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to,
        amount: amountValue.toString(),
        fromAddress,
        recipient,
      }),
    });
    const encodeData = (await encodeResponse.json()) as MesonEncodeResponse;
    if (encodeData.error) {
      throw new Error(
        `Meson encode error: ${encodeData.error.code} ${encodeData.error.message}`,
      );
    }
    assert(encodeData.result, 'Meson /swap encode missing result');
    const { encoded, signingRequest } = encodeData.result;
    const signingKeyWallet = wallet as ethers.Wallet & {
      signingKey?: {
        sign?: (digest: string) => { serialized: string };
        signDigest?: (digest: string) => ethers.Signature;
      };
      _signingKey?: () => {
        signDigest: (digest: string) => ethers.Signature;
      };
    };
    const signature =
      typeof signingKeyWallet.signingKey?.sign === 'function'
        ? signingKeyWallet.signingKey.sign(signingRequest.hash).serialized
        : typeof signingKeyWallet.signingKey?.signDigest === 'function'
          ? ethers.utils.joinSignature(
              signingKeyWallet.signingKey.signDigest(signingRequest.hash),
            )
          : signingKeyWallet._signingKey
            ? ethers.utils.joinSignature(
                signingKeyWallet._signingKey().signDigest(signingRequest.hash),
              )
            : (() => {
                throw new Error('Meson execute wallet cannot sign hash');
              })();

    this.logger.info(
      {
        quoteId: quote.id,
        encoded,
        fromAddress,
        recipient,
      },
      'Submitting Meson swap',
    );

    const submitResponse = await this.fetchWithRetry(
      `${this.apiUrl}/swap/${encoded}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromAddress, recipient, signature }),
      },
    );
    const submitData = (await submitResponse.json()) as MesonSwapResponse;
    if (submitData.error) {
      throw new Error(
        `Meson swap error: ${submitData.error.code} ${submitData.error.message}`,
      );
    }

    const swapId = submitData.result?.swapId ?? encoded;

    this.logger.info(
      {
        quoteId: quote.id,
        txHash: encoded,
        fromChain: quote.requestParams.fromChain,
        toChain: quote.requestParams.toChain,
        swapId,
      },
      'Meson swap submitted',
    );

    return {
      txHash: encoded,
      fromChain: quote.requestParams.fromChain,
      toChain: quote.requestParams.toChain,
      transferId: swapId,
    };
  }

  async getStatus(
    txHash: string,
    fromChain: number,
    toChain: number,
  ): Promise<BridgeTransferStatus> {
    this.logger.debug(
      { txHash, fromChain, toChain },
      'Fetching Meson swap status',
    );

    try {
      const response = await this.fetchWithRetry(
        `${this.apiUrl}/swap/${txHash}`,
        {
          method: 'GET',
        },
      );
      const data = (await response.json()) as MesonStatusResponse;

      if (data.error || !data.result) {
        return { status: 'not_found' };
      }

      switch (data.result.status) {
        case 'RELEASED':
          return {
            status: 'complete',
            receivingTxHash: data.result.outHash ?? '',
            receivedAmount: BigInt(data.result.amount ?? '0'),
          };
        case 'BONDED':
          return { status: 'pending', substatus: 'bonded' };
        case 'CANCELLED':
          return { status: 'failed', error: 'swap cancelled' };
        default:
          return { status: 'pending' };
      }
    } catch (error) {
      this.logger.warn(
        { txHash, fromChain, toChain, error },
        'Meson status lookup failed',
      );
      return { status: 'not_found' };
    }
  }

  private async fetchWithRetry(
    url: string,
    options?: RequestInit,
  ): Promise<Response> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });
        if (response.ok) {
          return response;
        }

        const responseText = await response.text();
        const error = new Error(
          `Meson API request failed: ${response.status} ${response.statusText} - ${responseText}`,
        );

        if (response.status !== 429 && response.status < 500) {
          throw new NonRetryableHttpError(error.message);
        }
        if (attempt === MAX_RETRIES) {
          throw error;
        }

        const backoffMs = BASE_BACKOFF_MS * 2 ** attempt;
        this.logger.warn(
          {
            url,
            status: response.status,
            attempt: attempt + 1,
            backoffMs,
          },
          'Meson request failed, retrying',
        );
        await this.sleep(backoffMs);
      } catch (error) {
        clearTimeout(timeout);

        if (error instanceof NonRetryableHttpError) {
          throw error;
        }
        if (attempt === MAX_RETRIES) {
          throw error;
        }

        const backoffMs = BASE_BACKOFF_MS * 2 ** attempt;
        this.logger.warn(
          { url, attempt: attempt + 1, backoffMs, error },
          'Meson request errored, retrying',
        );
        await this.sleep(backoffMs);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error('Meson API request failed after retries');
  }

  private parseMesonAmount(value?: string): bigint {
    if (!value) return 0n;
    const normalized = value.trim();
    if (/^\d+$/.test(normalized)) {
      return BigInt(normalized);
    }
    const [wholePart, fractionalPart = ''] = normalized.split('.');
    if (!/^\d+$/.test(wholePart) || !/^\d*$/.test(fractionalPart)) {
      return 0n;
    }
    const paddedFractional = (fractionalPart + '000000').slice(0, 6);
    return BigInt(wholePart) * 1_000_000n + BigInt(paddedFractional || '0');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
