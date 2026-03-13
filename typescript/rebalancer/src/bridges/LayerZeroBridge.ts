import { ethers } from 'ethers';
import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, ensure0x } from '@hyperlane-xyz/utils';
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
  OFT_ABI,
  ERC20_ABI,
  LAYERZERO_SCAN_API_URL,
  getOFTContract,
  getUSDTAddress,
  getEID,
  isSupportedRoute,
  isTronChain,
  addressToBytes32,
  type SendParam,
  type MessagingFee,
  type LayerZeroBridgeRoute,
  type LayerZeroScanResponse,
} from './layerZeroUtils.js';

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
    fromHex: (hexAddress: string) => string;
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

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  if (value && typeof value === 'object' && 'toString' in value) {
    return BigInt((value as { toString: () => string }).toString());
  }
  throw new Error(`Unable to convert value to bigint: ${String(value)}`);
}

function toTronHexAddress(address: string): string {
  const normalized = address.replace(/^0x/, '');
  if (normalized.startsWith('41') && normalized.length === 42)
    return normalized;
  if (normalized.length === 40) return `41${normalized}`;
  throw new Error(`Invalid Tron/EVM address: ${address}`);
}

function toEvmAddress(address: string): string {
  const normalized = address.replace(/^0x/, '');
  if (normalized.startsWith('41') && normalized.length === 42) {
    return `0x${normalized.slice(2)}`;
  }
  if (normalized.length === 40) {
    return `0x${normalized}`;
  }
  throw new Error(`Invalid address for EVM ABI encoding: ${address}`);
}

export class LayerZeroBridge implements IExternalBridge {
  readonly externalBridgeId = 'layerzero';
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

  async quote(
    params: BridgeQuoteParams,
  ): Promise<BridgeQuote<LayerZeroBridgeRoute>> {
    const { fromChain, toChain, fromAmount, toAmount, fromAddress, toAddress } =
      params;

    this.logger.debug(
      { integrator: this.config.integrator, fromChain, toChain },
      'Requesting LayerZero quote',
    );

    assert(
      isSupportedRoute(fromChain, toChain),
      `Unsupported route: ${fromChain} -> ${toChain}`,
    );
    assert(
      !(fromAmount !== undefined && toAmount !== undefined),
      'Cannot specify both fromAmount and toAmount - provide exactly one',
    );
    assert(
      fromAmount !== undefined || toAmount !== undefined,
      'Must specify either fromAmount or toAmount',
    );

    const oftContract = getOFTContract(fromChain, toChain);
    const dstEid = getEID(toChain);
    const targetAddress = toAddress ?? fromAddress;
    const amountLD = fromAmount ?? (toAmount! * 10000n) / 9970n;
    const sendParam: SendParam = {
      dstEid,
      to: addressToBytes32(targetAddress, isTronChain(toChain)),
      amountLD,
      minAmountLD: 0n,
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: '0x',
    };

    const iface = new ethers.utils.Interface(OFT_ABI);
    let oftFeeDetails: Array<{ feeAmountLD: bigint }> = [];
    let oftReceipt: { amountReceivedLD: bigint } = { amountReceivedLD: 0n };
    let messagingFee: MessagingFee = { nativeFee: 0n, lzTokenFee: 0n };

    if (!isTronChain(fromChain)) {
      const provider = new ethers.providers.JsonRpcProvider(
        this.getRpcUrl(fromChain),
      );
      const oft = new ethers.Contract(oftContract, OFT_ABI, provider);

      const quoteOFTResult = await oft.quoteOFT(sendParam);
      const quoteOFTTuple =
        quoteOFTResult.oftFeeDetails !== undefined
          ? quoteOFTResult
          : {
              oftFeeDetails: quoteOFTResult[1],
              oftReceipt: quoteOFTResult[2],
            };
      oftFeeDetails = (
        quoteOFTTuple.oftFeeDetails as Array<{ feeAmountLD: unknown }>
      ).map((fee) => ({ feeAmountLD: toBigInt(fee.feeAmountLD) }));
      oftReceipt = {
        amountReceivedLD: toBigInt(quoteOFTTuple.oftReceipt.amountReceivedLD),
      };
      sendParam.minAmountLD = oftReceipt.amountReceivedLD;

      const quoteSendResult = await oft.quoteSend(sendParam, false);
      const quoteSendTuple =
        quoteSendResult.nativeFee !== undefined
          ? quoteSendResult
          : quoteSendResult[0];
      messagingFee = {
        nativeFee: toBigInt(quoteSendTuple.nativeFee),
        lzTokenFee: toBigInt(quoteSendTuple.lzTokenFee),
      };
    } else {
      const rpcUrl = this.getRpcUrl(fromChain);
      const oftContractHex = toTronHexAddress(oftContract);

      const quoteOFTCalldata = iface.encodeFunctionData('quoteOFT', [
        sendParam,
      ]);
      const quoteOFTResponse = await this.fetchWithRetry(
        `${rpcUrl}/wallet/triggerconstantcontract`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            owner_address: '0x0000000000000000000000000000000000000000',
            contract_address: oftContractHex,
            data: quoteOFTCalldata,
            visible: false,
          }),
        },
      );
      const quoteOFTData = (await quoteOFTResponse.json()) as {
        constant_result?: string[];
      };
      const quoteOFTDecoded = iface.decodeFunctionResult(
        'quoteOFT',
        `0x${quoteOFTData.constant_result?.[0] ?? ''}`,
      );
      const tronOftFeeDetails = (
        quoteOFTDecoded[1] as Array<{ feeAmountLD: unknown }>
      ).map((fee) => ({ feeAmountLD: toBigInt(fee.feeAmountLD) }));
      const tronOftReceipt = quoteOFTDecoded[2] as {
        amountReceivedLD: unknown;
      };

      oftFeeDetails = tronOftFeeDetails;
      oftReceipt = {
        amountReceivedLD: toBigInt(tronOftReceipt.amountReceivedLD),
      };
      sendParam.minAmountLD = oftReceipt.amountReceivedLD;

      const quoteSendCalldata = iface.encodeFunctionData('quoteSend', [
        sendParam,
        false,
      ]);
      const quoteSendResponse = await this.fetchWithRetry(
        `${rpcUrl}/wallet/triggerconstantcontract`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            owner_address: '0x0000000000000000000000000000000000000000',
            contract_address: oftContractHex,
            data: quoteSendCalldata,
            visible: false,
          }),
        },
      );
      const quoteSendData = (await quoteSendResponse.json()) as {
        constant_result?: string[];
      };
      const quoteSendDecoded = iface.decodeFunctionResult(
        'quoteSend',
        `0x${quoteSendData.constant_result?.[0] ?? ''}`,
      );
      const tronMessagingFee = quoteSendDecoded[0] as {
        nativeFee: unknown;
        lzTokenFee: unknown;
      };
      messagingFee = {
        nativeFee: toBigInt(tronMessagingFee.nativeFee),
        lzTokenFee: toBigInt(tronMessagingFee.lzTokenFee),
      };
    }

    const feeCosts = oftFeeDetails.reduce(
      (sum, fee) => sum + fee.feeAmountLD,
      0n,
    );
    const gasCosts = messagingFee.nativeFee;

    return {
      id: crypto.randomUUID(),
      tool: 'layerzero',
      fromAmount: sendParam.amountLD,
      toAmount: oftReceipt.amountReceivedLD,
      toAmountMin: oftReceipt.amountReceivedLD,
      executionDuration: 120,
      gasCosts,
      feeCosts,
      route: {
        sendParam,
        messagingFee,
        oftContract,
        usdtContract: getUSDTAddress(fromChain),
        fromChainId: fromChain,
        toChainId: toChain,
      },
      requestParams: params,
    };
  }

  async execute(
    quote: BridgeQuote<LayerZeroBridgeRoute>,
    privateKeys: Partial<Record<ProtocolType, string>>,
  ): Promise<BridgeTransferResult> {
    const { route } = quote;
    const { fromChainId: fromChain, toChainId: toChain } = route;
    const rpcUrl = this.getRpcUrl(fromChain);

    if (!isTronChain(fromChain)) {
      const key = privateKeys[ProtocolType.Ethereum];
      assert(key, 'Missing private key for EVM chain');

      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(ensure0x(key), provider);

      const erc20 = new ethers.Contract(route.usdtContract, ERC20_ABI, wallet);
      const allowance = await erc20.allowance(
        wallet.address,
        route.oftContract,
      );
      if (toBigInt(allowance) < route.sendParam.amountLD) {
        const approveTx = await erc20.approve(
          route.oftContract,
          ethers.constants.MaxUint256,
        );
        await approveTx.wait();
      }

      const oft = new ethers.Contract(route.oftContract, OFT_ABI, wallet);
      const tx = await oft.send(
        route.sendParam,
        route.messagingFee,
        wallet.address,
        {
          value: route.messagingFee.nativeFee,
        },
      );
      await tx.wait();

      return {
        txHash: tx.hash,
        fromChain,
        toChain,
      };
    }

    const tronProtocol = 'tron' as ProtocolType;
    const key = privateKeys[tronProtocol];
    assert(key, 'Missing private key for Tron chain');

    const { TronWeb } = await import('tronweb');
    const strippedKey = key.replace(/^0x/, '');
    const tronWeb = new TronWeb({
      fullHost: rpcUrl,
      privateKey: strippedKey,
    }) as unknown as TronWebLike;
    const signerAddress = tronWeb.address.fromPrivateKey(strippedKey);

    const signerHex = tronWeb.address.toHex(signerAddress);
    const signerEvm = toEvmAddress(signerHex);
    const oftTronAddress = tronWeb.address.fromHex(
      toTronHexAddress(route.oftContract),
    );
    const usdtTronAddress = tronWeb.address.fromHex(
      toTronHexAddress(route.usdtContract),
    );

    const erc20Iface = new ethers.utils.Interface(ERC20_ABI);
    const allowanceCallData = erc20Iface.encodeFunctionData('allowance', [
      signerEvm,
      toEvmAddress(route.oftContract),
    ]);
    const allowanceResponse = await this.fetchWithRetry(
      `${rpcUrl}/wallet/triggerconstantcontract`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          owner_address: signerHex,
          contract_address: toTronHexAddress(route.usdtContract),
          data: allowanceCallData,
          visible: false,
        }),
      },
    );
    const allowanceData = (await allowanceResponse.json()) as {
      constant_result?: string[];
    };
    const allowanceDecoded = erc20Iface.decodeFunctionResult(
      'allowance',
      `0x${allowanceData.constant_result?.[0] ?? ''}`,
    );
    const allowance = toBigInt(allowanceDecoded[0]);

    if (allowance < route.sendParam.amountLD) {
      const approveResult =
        await tronWeb.transactionBuilder.triggerSmartContract(
          usdtTronAddress,
          'approve(address,uint256)',
          { callValue: 0, feeLimit: 100_000_000 },
          [
            { type: 'address', value: oftTronAddress },
            {
              type: 'uint256',
              value: ethers.constants.MaxUint256.toString(),
            },
          ],
          signerAddress,
        );
      assert(
        approveResult.transaction,
        'Tron approve transaction build failed',
      );
      const signedApprove = await tronWeb.trx.sign(approveResult.transaction);
      await tronWeb.trx.sendRawTransaction(signedApprove);
      await this.waitForTronTx(tronWeb, signedApprove.txID, rpcUrl);
    }

    const sendResult = await tronWeb.transactionBuilder.triggerSmartContract(
      oftTronAddress,
      'send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)',
      {
        callValue: Number(route.messagingFee.nativeFee),
        feeLimit: 500_000_000,
      },
      [
        {
          type: 'tuple(uint32,bytes32,uint256,uint256,bytes,bytes,bytes)',
          value: [
            route.sendParam.dstEid,
            route.sendParam.to,
            route.sendParam.amountLD.toString(),
            route.sendParam.minAmountLD.toString(),
            route.sendParam.extraOptions,
            route.sendParam.composeMsg,
            route.sendParam.oftCmd,
          ],
        },
        {
          type: 'tuple(uint256,uint256)',
          value: [
            route.messagingFee.nativeFee.toString(),
            route.messagingFee.lzTokenFee.toString(),
          ],
        },
        { type: 'address', value: signerAddress },
      ],
      signerAddress,
    );
    assert(sendResult.transaction, 'Tron send transaction build failed');

    const signedSend = await tronWeb.trx.sign(sendResult.transaction);
    await tronWeb.trx.sendRawTransaction(signedSend);
    await this.waitForTronTx(tronWeb, signedSend.txID, rpcUrl);

    return {
      txHash: sendResult.transaction.txID,
      fromChain,
      toChain,
    };
  }

  async getStatus(
    txHash: string,
    _fromChain: number,
    _toChain: number,
  ): Promise<BridgeTransferStatus> {
    const normalizedHash = txHash.startsWith('0x') ? txHash : `0x${txHash}`;
    const response = await this.fetchWithRetry(
      LAYERZERO_SCAN_API_URL + normalizedHash,
    );
    const data: LayerZeroScanResponse = await response.json();

    if (!data.messages || data.messages.length === 0) {
      return { status: 'not_found' };
    }

    const msg = data.messages[0];

    switch (msg.status) {
      case 'INFLIGHT':
        return { status: 'pending', substatus: 'INFLIGHT' };
      case 'DELIVERED':
        return {
          status: 'complete',
          receivingTxHash: msg.dstTxHash ?? '',
          receivedAmount: 0n,
        };
      case 'FAILED':
      case 'BLOCKED':
        return { status: 'failed', error: msg.status };
      default:
        return { status: 'pending', substatus: msg.status };
    }
  }

  private async waitForTronTx(
    tronWeb: TronWebLike,
    txId: string,
    rpcUrl: string,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const info = await tronWeb.trx.getTransactionInfo(txId);
      const result = info?.receipt?.result;

      if (result === 'FAILED') {
        throw new Error(`Tron transaction failed: ${txId} (${rpcUrl})`);
      }
      if (result === 'SUCCESS') {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(`Tron transaction timed out: ${txId} (${rpcUrl})`);
  }

  private async fetchWithRetry(
    url: string,
    options?: RequestInit,
    retries: number = 3,
  ): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)),
        );
      }
      try {
        const response = await fetch(url, options);
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
