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
  KATANA_FORWARD_CONFIG,
  KATANA_REVERSE_CONFIG,
  applySlippage,
  buildKatanaEthereumToKatana,
  buildKatanaToEthereumCompose,
  composerInterface,
  erc20Interface,
  oftInterface,
  previewInterface,
  type ApprovalTx,
  type BuiltRead,
  type BuiltTx,
  type OftSendParam,
} from './katanaUtils.js';

type KatanaDirection = 'ethereum-to-katana' | 'katana-to-ethereum';

type LayerZeroScanMessage = {
  status: string;
  dstTxHash?: string;
};

type LayerZeroScanResponse = {
  messages?: LayerZeroScanMessage[];
};

export type KatanaBridgeRoute = {
  kind: KatanaDirection;
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  recipient: string;
  refundAddress: string;
  previewAmount: bigint;
  nativeFee: bigint;
  sendParam: OftSendParam;
  quoteRead: BuiltRead;
  approvalCall: ApprovalTx;
  executionCall: BuiltTx;
};

const DEFAULT_SLIPPAGE = 0.005;
const EXECUTION_DURATION_S = 120;
const LAYERZERO_SCAN_API_URL = 'https://scan.layerzero-api.com/v1/messages/tx/';

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  if (value && typeof value === 'object' && 'toString' in value) {
    return BigInt((value as { toString: () => string }).toString());
  }
  throw new Error(`Unable to convert value to bigint: ${String(value)}`);
}

function addressesEqual(a: string, b: string): boolean {
  return normalizeAddressEvm(a) === normalizeAddressEvm(b);
}

export class KatanaBridge implements IExternalBridge {
  readonly externalBridgeId = 'katana';
  readonly logger: Logger;

  private readonly config: ExternalBridgeConfig;
  private readonly chainMetadataByChainId: Map<number, ChainMetadata>;

  constructor(config: ExternalBridgeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.chainMetadataByChainId = new Map();
    if (config.chainMetadata) {
      for (const metadata of Object.values(config.chainMetadata)) {
        if (metadata.chainId !== undefined) {
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
    const refundAddress = normalizeAddressEvm(params.fromAddress);
    const slippage =
      params.slippage ?? this.config.defaultSlippage ?? DEFAULT_SLIPPAGE;

    assert(direction, `Unsupported Katana route: ${fromChain} -> ${toChain}`);
    assert(toAmount === undefined, 'KatanaBridge does not support toAmount');
    assert(fromAmount !== undefined, 'KatanaBridge requires fromAmount');
    assert(fromAmount > 0n, 'KatanaBridge requires a positive fromAmount');

    if (direction === 'ethereum-to-katana') {
      const previewShares = await this.probePreviewAmount(
        fromChain,
        KATANA_FORWARD_CONFIG.vaultAddress,
        'previewDeposit',
        fromAmount,
      );
      const exactCall = buildKatanaEthereumToKatana({
        vaultAddress: KATANA_FORWARD_CONFIG.vaultAddress,
        composerAddress: KATANA_FORWARD_CONFIG.composerAddress,
        shareOftAddress: KATANA_FORWARD_CONFIG.shareOftAddress,
        underlyingTokenAddress: KATANA_FORWARD_CONFIG.fromToken,
        dstEid: KATANA_FORWARD_CONFIG.dstEid,
        recipient,
        amountLD: fromAmount,
        shareAmountLD: previewShares,
        minShareAmountLD: applySlippage(previewShares, slippage),
        refundAddress,
        extraOptions: KATANA_FORWARD_CONFIG.extraOptions,
        composeMsg: KATANA_FORWARD_CONFIG.composeMsg,
        oftCmd: KATANA_FORWARD_CONFIG.oftCmd,
      });
      const quoteFee = await this.probeQuoteSend(
        fromChain,
        exactCall.quoteRead,
      );

      return {
        id: crypto.randomUUID(),
        tool: 'katana-vault-bridge',
        fromAmount,
        toAmount: previewShares,
        toAmountMin: exactCall.sendParam.minAmountLD,
        executionDuration: EXECUTION_DURATION_S,
        gasCosts: quoteFee.nativeFee,
        feeCosts: 0n,
        route: {
          kind: direction,
          fromChainId: fromChain,
          toChainId: toChain,
          fromToken: normalizeAddressEvm(fromToken),
          toToken: normalizeAddressEvm(toToken),
          recipient,
          refundAddress,
          previewAmount: previewShares,
          nativeFee: quoteFee.nativeFee,
          sendParam: exactCall.sendParam,
          quoteRead: exactCall.quoteRead,
          approvalCall: exactCall.assetApproveTx,
          executionCall: {
            ...exactCall.depositAndSendTx,
            value: quoteFee.nativeFee,
          },
        },
        requestParams: params,
      };
    }

    const previewAssets = await this.probePreviewAmount(
      toChain,
      KATANA_REVERSE_CONFIG.vaultAddress,
      'previewRedeem',
      fromAmount,
    );
    const exactCall = buildKatanaToEthereumCompose({
      vaultAddress: KATANA_REVERSE_CONFIG.vaultAddress,
      composerAddress: KATANA_REVERSE_CONFIG.composerAddress,
      shareTokenAddress: KATANA_REVERSE_CONFIG.shareTokenAddress,
      shareOftAddress: KATANA_REVERSE_CONFIG.shareOftAddress,
      dstEid: KATANA_REVERSE_CONFIG.dstEid,
      recipient,
      shareAmountLD: fromAmount,
      minShareAmountLD: fromAmount,
      assetAmountLD: previewAssets,
      minAssetAmountLD: applySlippage(previewAssets, slippage),
      refundAddress,
      extraOptions: KATANA_REVERSE_CONFIG.extraOptions,
      receiveExtraOptions: KATANA_REVERSE_CONFIG.receiveExtraOptions,
      oftCmd: KATANA_REVERSE_CONFIG.oftCmd,
    });
    const quoteFee = await this.probeQuoteSend(fromChain, exactCall.quoteRead);
    const secondaryChainBalance = await this.probeSecondaryChainBalance(
      fromChain,
      KATANA_REVERSE_CONFIG.shareOftAddress,
    );
    if (secondaryChainBalance !== undefined) {
      assert(
        secondaryChainBalance >= fromAmount,
        `Insufficient Katana secondaryChainBalance: ${secondaryChainBalance} < ${fromAmount}`,
      );
    }

    return {
      id: crypto.randomUUID(),
      tool: 'katana-vault-bridge',
      fromAmount,
      toAmount: previewAssets,
      toAmountMin: exactCall.redemptionSendParam.minAmountLD,
      executionDuration: EXECUTION_DURATION_S,
      gasCosts: quoteFee.nativeFee,
      feeCosts: 0n,
      route: {
        kind: direction,
        fromChainId: fromChain,
        toChainId: toChain,
        fromToken: normalizeAddressEvm(fromToken),
        toToken: normalizeAddressEvm(toToken),
        recipient,
        refundAddress,
        previewAmount: previewAssets,
        nativeFee: quoteFee.nativeFee,
        sendParam: exactCall.sendParam,
        quoteRead: exactCall.quoteRead,
        approvalCall: exactCall.shareApproveTx,
        executionCall: {
          ...exactCall.sendTx,
          value: quoteFee.nativeFee,
          data: oftInterface.encodeFunctionData('send', [
            exactCall.sendParam,
            { nativeFee: quoteFee.nativeFee, lzTokenFee: 0 },
            refundAddress,
          ]),
        },
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
    assert(
      route.kind === 'ethereum-to-katana' ||
        route.kind === 'katana-to-ethereum',
      'Invalid KatanaBridge route',
    );

    const key = privateKeys[ProtocolType.Ethereum];
    assert(key, 'Missing EVM private key for KatanaBridge execution');

    const signerAddress = normalizeAddressEvm(
      new ethers.Wallet(ensure0x(key)).address,
    );
    this.validateExecutionQuote(quote, route, signerAddress);

    const allowance = await this.readAllowance(
      route.fromChainId,
      route.approvalCall.tokenAddress,
      signerAddress,
      route.approvalCall.spender,
    );
    if (allowance < route.approvalCall.amount) {
      await this.sendPreparedTransaction(route.fromChainId, key, {
        to: route.approvalCall.to,
        data: route.approvalCall.data,
        value: 0n,
      });
    }

    const receipt = await this.sendPreparedTransaction(
      route.fromChainId,
      key,
      route.executionCall,
    );
    const transferId = this.extractGuidFromReceipt(receipt);

    return {
      txHash: receipt.transactionHash,
      fromChain: route.fromChainId,
      toChain: route.toChainId,
      transferId,
    };
  }

  async getStatus(
    txHash: string,
    fromChain: number,
    toChain: number,
  ): Promise<BridgeTransferStatus> {
    const direction = this.getDirectionByChains(fromChain, toChain);
    if (!direction) {
      return {
        status: 'failed',
        error: `Unsupported Katana status route: ${fromChain} -> ${toChain}`,
      };
    }

    const normalizedHash = txHash.startsWith('0x') ? txHash : `0x${txHash}`;
    const response = await this.fetchWithRetry(
      `${LAYERZERO_SCAN_API_URL}${normalizedHash}`,
    );

    if (response.status === 404) {
      return { status: 'not_found' };
    }

    const data = (await response.json()) as LayerZeroScanResponse;
    if (!data.messages?.length) {
      return { status: 'not_found' };
    }

    const message = data.messages[0];
    switch (message.status) {
      case 'FAILED':
      case 'BLOCKED':
        return { status: 'failed', error: message.status };
      case 'DELIVERED': {
        const destinationTxHash = message.dstTxHash;
        if (!destinationTxHash) {
          return { status: 'pending', substatus: 'DELIVERED' };
        }

        const receipt = await this.getTransactionReceipt(
          toChain,
          destinationTxHash,
        );
        if (!receipt) {
          return { status: 'pending', substatus: 'DELIVERED' };
        }

        const receivedAmount = this.extractReceivedAmount(direction, receipt);
        if (receivedAmount === undefined) {
          return {
            status: 'failed',
            error: 'Unable to parse Katana destination received amount',
          };
        }

        return {
          status: 'complete',
          receivingTxHash: destinationTxHash,
          receivedAmount,
        };
      }
      case 'INFLIGHT':
        return { status: 'pending', substatus: 'INFLIGHT' };
      default:
        return { status: 'pending', substatus: message.status };
    }
  }

  protected getProvider(chainId: number): ethers.providers.JsonRpcProvider {
    return new ethers.providers.JsonRpcProvider(this.getRpcUrl(chainId));
  }

  protected async callContract(
    chainId: number,
    to: string,
    data: string,
  ): Promise<string> {
    return this.getProvider(chainId).call({ to, data });
  }

  protected async getTransactionReceipt(
    chainId: number,
    txHash: string,
  ): Promise<ethers.providers.TransactionReceipt | undefined> {
    return this.getProvider(chainId).getTransactionReceipt(txHash);
  }

  protected async sendPreparedTransaction(
    chainId: number,
    privateKey: string,
    call: BuiltTx,
  ): Promise<ethers.providers.TransactionReceipt> {
    const provider = this.getProvider(chainId);
    const wallet = new ethers.Wallet(ensure0x(privateKey), provider);
    const tx = await wallet.sendTransaction({
      to: call.to,
      data: call.data,
      value: call.value.toString(),
    });
    return tx.wait();
  }

  protected async fetchWithRetry(
    url: string,
    options?: RequestInit,
    retries: number = 3,
  ): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * 2 ** (attempt - 1)),
        );
      }
      try {
        const response = await fetch(url, options);
        if (response.status === 404) return response;
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
      } catch (error) {
        if (error instanceof Error && /^HTTP 4\d\d/.test(error.message))
          throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error(`fetchWithRetry exhausted retries for ${url}`);
  }

  private getDirection(
    fromChain: number,
    toChain: number,
    fromToken: string,
    toToken: string,
  ): KatanaDirection | undefined {
    if (
      fromChain === KATANA_FORWARD_CONFIG.fromChainId &&
      toChain === KATANA_FORWARD_CONFIG.toChainId &&
      addressesEqual(fromToken, KATANA_FORWARD_CONFIG.fromToken) &&
      addressesEqual(toToken, KATANA_FORWARD_CONFIG.toToken)
    ) {
      return 'ethereum-to-katana';
    }

    if (
      fromChain === KATANA_REVERSE_CONFIG.fromChainId &&
      toChain === KATANA_REVERSE_CONFIG.toChainId &&
      addressesEqual(fromToken, KATANA_REVERSE_CONFIG.fromToken) &&
      addressesEqual(toToken, KATANA_REVERSE_CONFIG.toToken)
    ) {
      return 'katana-to-ethereum';
    }

    return undefined;
  }

  private getDirectionByChains(
    fromChain: number,
    toChain: number,
  ): KatanaDirection | undefined {
    if (
      fromChain === KATANA_FORWARD_CONFIG.fromChainId &&
      toChain === KATANA_FORWARD_CONFIG.toChainId
    ) {
      return 'ethereum-to-katana';
    }
    if (
      fromChain === KATANA_REVERSE_CONFIG.fromChainId &&
      toChain === KATANA_REVERSE_CONFIG.toChainId
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
    const { requestParams } = quote;
    const expectedDirection = this.getDirection(
      requestParams.fromChain,
      requestParams.toChain,
      requestParams.fromToken,
      requestParams.toToken,
    );

    assert(
      expectedDirection === route.kind,
      'Route kind does not match request',
    );
    assert(
      requestParams.fromAmount === quote.fromAmount,
      'Quote fromAmount does not match request',
    );
    assert(
      addressesEqual(requestParams.fromAddress, signerAddress),
      `Signer ${signerAddress} does not match quote.fromAddress ${requestParams.fromAddress}`,
    );

    const expectedRecipient = normalizeAddressEvm(
      requestParams.toAddress ?? requestParams.fromAddress,
    );
    assert(
      addressesEqual(route.recipient, expectedRecipient),
      `Route recipient ${route.recipient} does not match quote recipient ${expectedRecipient}`,
    );
  }

  private async probePreviewAmount(
    chainId: number,
    contractAddress: string,
    functionName: 'previewDeposit' | 'previewRedeem',
    amount: bigint,
  ): Promise<bigint> {
    const data = previewInterface.encodeFunctionData(functionName, [
      amount.toString(),
    ]);
    const raw = await this.callContract(chainId, contractAddress, data);
    const decoded = previewInterface.decodeFunctionResult(functionName, raw);
    return toBigInt(decoded[0]);
  }

  private async probeQuoteSend(
    chainId: number,
    quoteRead: BuiltRead,
  ): Promise<{ nativeFee: bigint; lzTokenFee: bigint }> {
    const raw = await this.callContract(chainId, quoteRead.to, quoteRead.data);
    const decoded = oftInterface.decodeFunctionResult('quoteSend', raw);
    const fee = decoded.msgFee ?? decoded[0];
    return {
      nativeFee: toBigInt(fee.nativeFee),
      lzTokenFee: toBigInt(fee.lzTokenFee),
    };
  }

  private async probeSecondaryChainBalance(
    chainId: number,
    shareOftAddress: string,
  ): Promise<bigint | undefined> {
    try {
      const data = oftInterface.encodeFunctionData('secondaryChainBalance', []);
      const raw = await this.callContract(chainId, shareOftAddress, data);
      const decoded = oftInterface.decodeFunctionResult(
        'secondaryChainBalance',
        raw,
      );
      return toBigInt(decoded[0]);
    } catch {
      return undefined;
    }
  }

  protected async readAllowance(
    chainId: number,
    tokenAddress: string,
    owner: string,
    spender: string,
  ): Promise<bigint> {
    const provider = this.getProvider(chainId);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return toBigInt(await token.allowance(owner, spender));
  }

  private extractGuidFromReceipt(
    receipt: ethers.providers.TransactionReceipt,
  ): string | undefined {
    for (const log of receipt.logs) {
      try {
        const parsed = oftInterface.parseLog(log);
        if (parsed.name === 'OFTSent') {
          return parsed.args.guid;
        }
      } catch {}

      try {
        const parsed = composerInterface.parseLog(log);
        if (parsed.name === 'Sent') {
          return parsed.args.guid;
        }
      } catch {}
    }

    return undefined;
  }

  private extractReceivedAmount(
    direction: KatanaDirection,
    receipt: ethers.providers.TransactionReceipt,
  ): bigint | undefined {
    if (direction === 'ethereum-to-katana') {
      for (const log of receipt.logs) {
        if (
          !addressesEqual(
            log.address,
            KATANA_FORWARD_CONFIG.destinationShareOftAddress,
          )
        ) {
          continue;
        }
        try {
          const parsed = oftInterface.parseLog(log);
          if (parsed.name === 'OFTReceived') {
            return toBigInt(parsed.args.amountReceivedLD);
          }
        } catch {}
      }
      return this.extractLargestTransfer(
        receipt,
        KATANA_FORWARD_CONFIG.toToken,
      );
    }

    for (const log of receipt.logs) {
      if (!addressesEqual(log.address, KATANA_REVERSE_CONFIG.composerAddress)) {
        continue;
      }
      try {
        const parsed = composerInterface.parseLog(log);
        if (parsed.name === 'Redeemed') {
          return toBigInt(parsed.args.assetAmt);
        }
      } catch {}
    }

    return this.extractLargestTransfer(receipt, KATANA_REVERSE_CONFIG.toToken);
  }

  private extractLargestTransfer(
    receipt: ethers.providers.TransactionReceipt,
    tokenAddress: string,
  ): bigint | undefined {
    let largest = 0n;

    for (const log of receipt.logs) {
      if (!addressesEqual(log.address, tokenAddress)) {
        continue;
      }
      try {
        const parsed = erc20Interface.parseLog(log);
        if (parsed.name === 'Transfer') {
          const value = toBigInt(parsed.args.value);
          if (value > largest) largest = value;
        }
      } catch {}
    }

    return largest > 0n ? largest : undefined;
  }

  private getRpcUrl(chainId: number): string {
    const rpcUrl = this.chainMetadataByChainId.get(chainId)?.rpcUrls?.[0]?.http;
    assert(rpcUrl, `No RPC URL configured for chain ${chainId}`);
    return rpcUrl;
  }
}
