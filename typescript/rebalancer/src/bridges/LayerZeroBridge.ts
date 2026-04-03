import { ethers } from 'ethers';
import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, ensure0x } from '@hyperlane-xyz/utils';
import type { Logger } from 'pino';

import { TronSigner } from '@hyperlane-xyz/tron-sdk';

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
  TRON_CHAIN_ID,
  getOFTContractForRoute,
  getUSDTAddress,
  getEID,
  isSupportedRoute,
  addressToBytes32,
  type SendParam,
  type MessagingFee,
  type LayerZeroBridgeRoute,
} from './layerZeroUtils.js';

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
      for (const [, metadata] of Object.entries(config.chainMetadata)) {
        if (
          metadata.chainId !== undefined &&
          (metadata.protocol === ProtocolType.Ethereum ||
            metadata.protocol === ('tron' as ProtocolType))
        ) {
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

    const { address: oftContract, network } = getOFTContractForRoute(
      fromChain,
      toChain,
    );
    const dstEid = getEID(toChain);
    const targetAddress = toAddress ?? fromAddress;
    const amountLD = fromAmount ?? (toAmount! * 10000n) / 9970n;
    const sendParam: SendParam = {
      dstEid,
      to: addressToBytes32(targetAddress),
      amountLD,
      minAmountLD: 0n,
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: '0x',
    };

    const provider = new ethers.providers.StaticJsonRpcProvider(
      this.getRpcUrl(fromChain),
      fromChain,
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
    const oftFeeDetails = (
      quoteOFTTuple.oftFeeDetails as Array<{
        feeAmountLD: { toString(): string };
      }>
    ).map((fee) => ({ feeAmountLD: BigInt(fee.feeAmountLD.toString()) }));
    const oftReceipt = {
      amountReceivedLD: BigInt(
        quoteOFTTuple.oftReceipt.amountReceivedLD.toString(),
      ),
    };
    sendParam.minAmountLD = oftReceipt.amountReceivedLD;

    const quoteSendResult = await oft.quoteSend(sendParam, false);
    const quoteSendTuple =
      quoteSendResult.nativeFee !== undefined
        ? quoteSendResult
        : quoteSendResult[0];
    const messagingFee: MessagingFee = {
      nativeFee: BigInt(quoteSendTuple.nativeFee.toString()),
      lzTokenFee: BigInt(quoteSendTuple.lzTokenFee.toString()),
    };

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
        network,
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

    if (fromChain === TRON_CHAIN_ID) {
      return this.executeTron(route, privateKeys);
    }

    const key = privateKeys[ProtocolType.Ethereum];
    assert(key, 'Missing private key for EVM chain');

    const provider = new ethers.providers.StaticJsonRpcProvider(
      this.getRpcUrl(fromChain),
      fromChain,
    );
    const wallet = new ethers.Wallet(ensure0x(key), provider);

    const erc20 = new ethers.Contract(route.usdtContract, ERC20_ABI, wallet);
    const allowance = await erc20.allowance(wallet.address, route.oftContract);
    if (BigInt(allowance.toString()) < route.sendParam.amountLD) {
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

  private async executeTron(
    route: LayerZeroBridgeRoute,
    privateKeys: Partial<Record<ProtocolType, string>>,
  ): Promise<BridgeTransferResult> {
    const { fromChainId: fromChain, toChainId: toChain } = route;

    const tronKey = privateKeys['tron' as ProtocolType];
    assert(tronKey, 'Missing private key for Tron chain');
    const strippedKey = tronKey.replace(/^0x/, '');

    const tronSigner = (await TronSigner.connectWithSigner(
      [this.getRpcUrl(fromChain)],
      strippedKey,
      { metadata: {} },
    )) as TronSigner;

    const tronWeb = tronSigner.getTronweb();
    const signerAddress = tronSigner.getSignerAddress();

    const oftContractTron = tronWeb.address.fromHex(
      '41' + route.oftContract.slice(2),
    );
    const usdtContractTron = tronWeb.address.fromHex(
      '41' + route.usdtContract.slice(2),
    );

    const { transaction: approveTx } =
      await tronWeb.transactionBuilder.triggerSmartContract(
        usdtContractTron,
        'approve(address,uint256)',
        {},
        [
          { type: 'address', value: oftContractTron },
          {
            type: 'uint256',
            value: route.sendParam.amountLD.toString(),
          },
        ],
        signerAddress,
      );
    await tronSigner.sendAndConfirmTransaction(approveTx);

    const iface = new ethers.utils.Interface(OFT_ABI);
    const signerHex = tronWeb.address.toHex(signerAddress);
    const signerEvmAddress = '0x' + signerHex.slice(2);

    const encoded = iface.encodeFunctionData('send', [
      [
        route.sendParam.dstEid,
        route.sendParam.to,
        route.sendParam.amountLD,
        route.sendParam.minAmountLD,
        route.sendParam.extraOptions,
        route.sendParam.composeMsg,
        route.sendParam.oftCmd,
      ],
      [route.messagingFee.nativeFee, route.messagingFee.lzTokenFee],
      signerEvmAddress,
    ]);

    const nativeFee = Number(route.messagingFee.nativeFee);
    const rawParameter = encoded.slice(10);

    const { transaction: sendTx } =
      await tronWeb.transactionBuilder.triggerSmartContract(
        oftContractTron,
        'send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)',
        { callValue: nativeFee, feeLimit: 500_000_000, rawParameter },
        [],
        signerAddress,
      );

    const receipt = await tronSigner.sendAndConfirmTransaction(sendTx);
    return { txHash: receipt.id, fromChain, toChain };
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
    const responseData = await response.json();

    // LZ Scan API returns { data: [...] } with status at data[].status.name
    // and destination tx at data[].destination.tx.txHash
    const messages = responseData.data ?? responseData.messages ?? [];
    if (!messages || messages.length === 0) {
      return { status: 'not_found' };
    }

    const msg = messages[0];
    const statusName = msg.status?.name ?? msg.status;
    const dstTxHash = msg.destination?.tx?.txHash ?? msg.dstTxHash ?? '';

    switch (statusName) {
      case 'INFLIGHT':
        return { status: 'pending', substatus: 'INFLIGHT' };
      case 'DELIVERED':
        return {
          status: 'complete',
          receivingTxHash: dstTxHash,
          receivedAmount: 0n,
        };
      case 'FAILED':
      case 'BLOCKED':
        return { status: 'failed', error: statusName };
      default:
        return { status: 'pending', substatus: statusName };
    }
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
