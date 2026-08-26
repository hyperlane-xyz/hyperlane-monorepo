import { ethers } from 'ethers';
import { Options } from '@layerzerolabs/lz-v2-utilities';
import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, ensure0x } from '@hyperlane-xyz/utils';
import type { Logger } from 'pino';

import { TronSigner } from '@hyperlane-xyz/tron-sdk';
import { Erc20ApprovalMode, approveErc20IfNeeded } from './erc20Approve.js';
import { solanaLayerZeroClient } from './layerZeroSolanaClient.js';

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
  LAYERZERO_SCAN_API_URL,
  TRON_CHAIN_ID,
  SOLANA_CHAIN_ID,
  SOLANA_OFT_PROGRAM,
  SOLANA_OFT_STORE,
  ARB_HUB_EID,
  ARB_HUB_CHAIN_ID,
  MULTIHOP_COMPOSER,
  LayerZeroScanResponseSchema,
  getOFTContractForRoute,
  getComposeHopContracts,
  getUSDTAddress,
  getEID,
  getRouteNetwork,
  isSupportedRoute,
  addressToBytes32,
  type SendParam,
  type MessagingFee,
  type LayerZeroBridgeRoute,
  type LayerZeroScanMessage,
} from './layerZeroUtils.js';

const MESSAGE_TERMINAL_FAILURES = new Set([
  'APPLICATION_BURNED',
  'APPLICATION_SKIPPED',
  'UNRESOLVABLE_COMMAND',
  'MALFORMED_COMMAND',
]);

type MessageEvaluation =
  | { status: 'pending'; substatus: string }
  | { status: 'failed'; error: string }
  | { status: 'complete'; receivingTxHash: string };

function getTupleValue(
  value: unknown,
  property: string,
  index: number,
): unknown {
  assert(value !== null && typeof value === 'object', 'Invalid OFT response');
  if (property in value) return Reflect.get(value, property);
  if (Array.isArray(value)) return value[index];
  throw new Error(`OFT response is missing ${property}`);
}

function toBigInt(value: unknown, field: string): bigint {
  assert(value !== null && value !== undefined, `Missing ${field}`);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    assert(Number.isSafeInteger(value), `Invalid ${field}: unsafe number`);
    return BigInt(value);
  }
  const serialized =
    typeof value === 'string'
      ? value
      : ethers.BigNumber.isBigNumber(value)
        ? value.toString()
        : undefined;
  assert(serialized !== undefined, `Invalid ${field}: unsupported value`);
  try {
    return BigInt(serialized);
  } catch (error: unknown) {
    throw new Error(`Invalid ${field}: ${String(error)}`);
  }
}

function getOftReceivedAmount(value: unknown, field: string): bigint {
  const receipt = getTupleValue(value, 'oftReceipt', 2);
  return toBigInt(
    getTupleValue(receipt, 'amountReceivedLD', 1),
    `${field} received amount`,
  );
}

function getNativeMessagingFee(value: unknown, field: string): bigint {
  const messagingFee =
    value !== null && typeof value === 'object' && 'nativeFee' in value
      ? value
      : getTupleValue(value, 'messagingFee', 0);
  return toBigInt(
    getTupleValue(messagingFee, 'nativeFee', 0),
    `${field} native messaging fee`,
  );
}

function getStatusName(status: LayerZeroScanMessage['status']): string {
  return typeof status === 'string' ? status : status.name;
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
      for (const [, metadata] of Object.entries(config.chainMetadata)) {
        if (
          metadata.chainId !== undefined &&
          (metadata.protocol === ProtocolType.Ethereum ||
            metadata.protocol === ProtocolType.Tron ||
            metadata.protocol === ProtocolType.Sealevel)
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
    this.assertUsdtRoute(params);

    const network = getRouteNetwork(fromChain, toChain);
    assert(network, `Unsupported route: ${fromChain} -> ${toChain}`);
    const targetAddress = toAddress ?? fromAddress;
    let amountLD: bigint;
    if (fromAmount !== undefined) {
      amountLD = fromAmount;
    } else {
      assert(toAmount !== undefined, 'Missing destination amount');
      amountLD = (toAmount * 10000n) / 9970n;
    }
    assert(amountLD > 0n, 'Transfer amount must be positive');

    if (fromChain === SOLANA_CHAIN_ID) {
      if (network === 'compose') {
        return this.quoteComposeFromSolana(
          params,
          amountLD,
          targetAddress,
          toChain,
        );
      }
      const dstEid = getEID(toChain);
      return this.quoteSolanaDirect(params, amountLD, targetAddress, dstEid);
    }

    if (network === 'compose') {
      return this.quoteCompose(params, amountLD, targetAddress);
    }

    const { address: oftContract } = getOFTContractForRoute(fromChain, toChain);
    const dstEid = getEID(toChain);
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
    const oftFeeDetailsValue = getTupleValue(
      quoteOFTResult,
      'oftFeeDetails',
      1,
    );
    assert(Array.isArray(oftFeeDetailsValue), 'Invalid OFT fee details');
    const oftFeeDetails = oftFeeDetailsValue.map((fee) => ({
      feeAmountLD: toBigInt(
        getTupleValue(fee, 'feeAmountLD', 0),
        'OFT fee amount',
      ),
    }));
    const oftReceiptValue = getTupleValue(quoteOFTResult, 'oftReceipt', 2);
    const oftReceipt = {
      amountReceivedLD: toBigInt(
        getTupleValue(oftReceiptValue, 'amountReceivedLD', 1),
        'OFT received amount',
      ),
    };
    sendParam.minAmountLD = oftReceipt.amountReceivedLD;

    const quoteSendResult = await oft.quoteSend(sendParam, false);
    const quoteSendTuple =
      quoteSendResult !== null &&
      typeof quoteSendResult === 'object' &&
      'nativeFee' in quoteSendResult
        ? quoteSendResult
        : getTupleValue(quoteSendResult, 'messagingFee', 0);
    const messagingFee: MessagingFee = {
      nativeFee: toBigInt(
        getTupleValue(quoteSendTuple, 'nativeFee', 0),
        'native messaging fee',
      ),
      lzTokenFee: toBigInt(
        getTupleValue(quoteSendTuple, 'lzTokenFee', 1),
        'LayerZero token fee',
      ),
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
        kind: fromChain === TRON_CHAIN_ID ? 'tron' : 'evm',
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

  /**
   * Two-step fee estimation for compose routes (native-only ↔ legacy-only).
   *
   * Flow:
   *   Step 1: Quote second hop (Arbitrum hub → destination) to get nextHopNativeFee
   *   Step 2: Build compose options (lzReceive + lzCompose with packed fee)
   *   Step 3: Build first hop SendParam with composeMsg = abi.encode(nextHopSendParam)
   *   Step 4: Quote first hop (source → Arbitrum Composer) to get total fee
   */
  private async quoteCompose(
    params: BridgeQuoteParams,
    amountLD: bigint,
    targetAddress: string,
  ): Promise<BridgeQuote<LayerZeroBridgeRoute>> {
    const { fromChain, toChain } = params;
    const { firstHopOFT, secondHopOFT } = getComposeHopContracts(
      fromChain,
      toChain,
    );
    const composerBytes32 = addressToBytes32(MULTIHOP_COMPOSER);

    // ── Step 1: Pre-quote first hop (source → Arbitrum composer) ───────────
    const sourceProvider = new ethers.providers.StaticJsonRpcProvider(
      this.getRpcUrl(fromChain),
      fromChain,
    );
    const firstHopOFTContract = new ethers.Contract(
      firstHopOFT,
      OFT_ABI,
      sourceProvider,
    );
    const firstHopPrequoteSendParam: SendParam = {
      dstEid: ARB_HUB_EID,
      to: composerBytes32,
      amountLD,
      minAmountLD: 0n,
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: '0x',
    };
    const firstHopPrequoteResult = await firstHopOFTContract.quoteOFT(
      firstHopPrequoteSendParam,
    );
    const firstHopReceivedLD = getOftReceivedAmount(
      firstHopPrequoteResult,
      'first hop',
    );

    // ── Step 2: Quote second hop (Arbitrum → destination) ──────────────────
    const arbProvider = new ethers.providers.StaticJsonRpcProvider(
      this.getRpcUrl(ARB_HUB_CHAIN_ID),
      ARB_HUB_CHAIN_ID,
    );
    const secondHopOFTContract = new ethers.Contract(
      secondHopOFT,
      OFT_ABI,
      arbProvider,
    );
    const secondHopSendParam: SendParam = {
      dstEid: getEID(toChain),
      to: addressToBytes32(targetAddress),
      amountLD: firstHopReceivedLD,
      minAmountLD: 0n,
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: '0x',
    };
    // quoteOFT to get minAmountLD after Legacy Mesh 0.03% fee
    const secondHopOFTResult =
      await secondHopOFTContract.quoteOFT(secondHopSendParam);
    const secondHopReceivedLD = getOftReceivedAmount(
      secondHopOFTResult,
      'second hop',
    );
    secondHopSendParam.minAmountLD = secondHopReceivedLD;

    const secondHopFeeResult = await secondHopOFTContract.quoteSend(
      secondHopSendParam,
      false,
    );
    const nextHopNativeFee = getNativeMessagingFee(
      secondHopFeeResult,
      'second hop',
    );

    // ── Step 3: Encode composeMsg = abi.encode(nextHopSendParam) ───────────
    const abiCoder = new ethers.utils.AbiCoder();
    const composeMsg = abiCoder.encode(
      ['tuple(uint32,bytes32,uint256,uint256,bytes,bytes,bytes)'],
      [
        [
          secondHopSendParam.dstEid,
          secondHopSendParam.to,
          secondHopSendParam.amountLD,
          secondHopSendParam.minAmountLD,
          secondHopSendParam.extraOptions,
          secondHopSendParam.composeMsg,
          secondHopSendParam.oftCmd,
        ],
      ],
    );

    // ── Step 4: Build first hop options with compose gas + packed fee ───────
    const firstHopOptions = Options.newOptions()
      .addExecutorLzReceiveOption(65_000, 0)
      .addExecutorComposeOption(0, 500_000, nextHopNativeFee);
    const firstHopSendParam: SendParam = {
      dstEid: ARB_HUB_EID,
      to: composerBytes32,
      amountLD,
      minAmountLD: firstHopReceivedLD,
      extraOptions: firstHopOptions.toHex(),
      composeMsg,
      oftCmd: '0x',
    };

    // ── Step 5: Quote first hop fee (source → Arbitrum Composer) ───────────
    const firstHopFeeResult = await firstHopOFTContract.quoteSend(
      firstHopSendParam,
      false,
    );
    const totalNativeFee = getNativeMessagingFee(
      firstHopFeeResult,
      'first hop',
    );

    const messagingFee: MessagingFee = {
      nativeFee: totalNativeFee,
      lzTokenFee: 0n,
    };

    return {
      id: crypto.randomUUID(),
      tool: 'layerzero',
      fromAmount: amountLD,
      toAmount: secondHopReceivedLD,
      toAmountMin: secondHopReceivedLD,
      executionDuration: 300, // compose takes longer (two hops)
      gasCosts: totalNativeFee,
      feeCosts: 0n,
      route: {
        kind: fromChain === TRON_CHAIN_ID ? 'tron' : 'evm',
        sendParam: firstHopSendParam,
        messagingFee,
        oftContract: firstHopOFT,
        usdtContract: getUSDTAddress(fromChain),
        fromChainId: fromChain,
        toChainId: toChain,
        network: 'compose',
        composeSendParam: secondHopSendParam,
        composeMessagingFee: { nativeFee: nextHopNativeFee, lzTokenFee: 0n },
      },
      requestParams: params,
    };
  }

  private async quoteSolanaDirect(
    params: BridgeQuoteParams,
    amountLD: bigint,
    targetAddress: string,
    dstEid: number,
  ): Promise<BridgeQuote<LayerZeroBridgeRoute>> {
    const { fromChain, toChain, fromAddress } = params;
    const toBytes32 = addressToBytes32(targetAddress);
    const quote = await solanaLayerZeroClient.quoteSolanaTransfer({
      rpcUrl: this.getRpcUrl(fromChain),
      fromAddress,
      programId: SOLANA_OFT_PROGRAM,
      store: SOLANA_OFT_STORE,
      tokenMint: getUSDTAddress(fromChain),
      dstEid,
      toBytes32,
      amountLd: amountLD,
      minAmountLd: 0n,
    });

    return {
      id: crypto.randomUUID(),
      tool: 'layerzero',
      fromAmount: amountLD,
      toAmount: quote.amountReceivedLd,
      toAmountMin: quote.amountReceivedLd,
      executionDuration: 120,
      gasCosts: quote.messagingFee.nativeFee,
      feeCosts: quote.feeCosts,
      route: {
        kind: 'solana',
        fromChainId: fromChain,
        toChainId: toChain,
        network: 'legacy',
        programId: SOLANA_OFT_PROGRAM,
        store: SOLANA_OFT_STORE,
        tokenMint: getUSDTAddress(fromChain),
        destinationEid: dstEid,
        toBytes32,
        amountLd: amountLD,
        minAmountLd: quote.amountReceivedLd,
        extraOptionsHex: '0x',
        composeMsgHex: '0x',
        nativeFeeLamports: quote.messagingFee.nativeFee,
        lzTokenFee: quote.messagingFee.lzTokenFee,
      },
      requestParams: params,
    };
  }

  private async quoteComposeFromSolana(
    params: BridgeQuoteParams,
    amountLD: bigint,
    targetAddress: string,
    toChain: number,
  ): Promise<BridgeQuote<LayerZeroBridgeRoute>> {
    const { fromChain, fromAddress } = params;
    const { secondHopOFT } = getComposeHopContracts(fromChain, toChain);
    const targetBytes32 = addressToBytes32(targetAddress);
    const composerBytes32 = addressToBytes32(MULTIHOP_COMPOSER);

    const prequote = await solanaLayerZeroClient.quoteSolanaTransfer({
      rpcUrl: this.getRpcUrl(fromChain),
      fromAddress,
      programId: SOLANA_OFT_PROGRAM,
      store: SOLANA_OFT_STORE,
      tokenMint: getUSDTAddress(fromChain),
      dstEid: ARB_HUB_EID,
      toBytes32: composerBytes32,
      amountLd: amountLD,
      minAmountLd: 0n,
    });

    const arbProvider = new ethers.providers.StaticJsonRpcProvider(
      this.getRpcUrl(ARB_HUB_CHAIN_ID),
      ARB_HUB_CHAIN_ID,
    );
    const secondHopOFTContract = new ethers.Contract(
      secondHopOFT,
      OFT_ABI,
      arbProvider,
    );
    const secondHopSendParam: SendParam = {
      dstEid: getEID(toChain),
      to: targetBytes32,
      amountLD: prequote.amountReceivedLd,
      minAmountLD: 0n,
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: '0x',
    };
    const secondHopOFTResult =
      await secondHopOFTContract.quoteOFT(secondHopSendParam);
    const secondHopReceivedLD = getOftReceivedAmount(
      secondHopOFTResult,
      'second hop',
    );
    secondHopSendParam.minAmountLD = secondHopReceivedLD;

    const secondHopFeeResult = await secondHopOFTContract.quoteSend(
      secondHopSendParam,
      false,
    );
    const nextHopNativeFee = getNativeMessagingFee(
      secondHopFeeResult,
      'second hop',
    );

    const abiCoder = new ethers.utils.AbiCoder();
    const composeMsg = abiCoder.encode(
      ['tuple(uint32,bytes32,uint256,uint256,bytes,bytes,bytes)'],
      [
        [
          secondHopSendParam.dstEid,
          secondHopSendParam.to,
          secondHopSendParam.amountLD,
          secondHopSendParam.minAmountLD,
          secondHopSendParam.extraOptions,
          secondHopSendParam.composeMsg,
          secondHopSendParam.oftCmd,
        ],
      ],
    );
    const firstHopOptions = Options.newOptions()
      .addExecutorLzReceiveOption(65_000, 0)
      .addExecutorComposeOption(0, 500_000, nextHopNativeFee);

    const quote = await solanaLayerZeroClient.quoteSolanaTransfer({
      rpcUrl: this.getRpcUrl(fromChain),
      fromAddress,
      programId: SOLANA_OFT_PROGRAM,
      store: SOLANA_OFT_STORE,
      tokenMint: getUSDTAddress(fromChain),
      dstEid: ARB_HUB_EID,
      toBytes32: composerBytes32,
      amountLd: amountLD,
      minAmountLd: 0n,
      extraOptionsHex: firstHopOptions.toHex(),
      composeMsgHex: composeMsg,
    });

    return {
      id: crypto.randomUUID(),
      tool: 'layerzero',
      fromAmount: amountLD,
      toAmount: secondHopReceivedLD,
      toAmountMin: secondHopReceivedLD,
      executionDuration: 300,
      gasCosts: quote.messagingFee.nativeFee,
      feeCosts: quote.feeCosts,
      route: {
        kind: 'solana',
        fromChainId: fromChain,
        toChainId: toChain,
        network: 'compose',
        programId: SOLANA_OFT_PROGRAM,
        store: SOLANA_OFT_STORE,
        tokenMint: getUSDTAddress(fromChain),
        destinationEid: ARB_HUB_EID,
        toBytes32: composerBytes32,
        amountLd: amountLD,
        minAmountLd: quote.amountReceivedLd,
        extraOptionsHex: firstHopOptions.toHex(),
        composeMsgHex: composeMsg,
        nativeFeeLamports: quote.messagingFee.nativeFee,
        lzTokenFee: quote.messagingFee.lzTokenFee,
      },
      requestParams: params,
    };
  }

  async execute(
    quote: BridgeQuote<LayerZeroBridgeRoute>,
    privateKeys: Partial<Record<ProtocolType, string>>,
  ): Promise<BridgeTransferResult> {
    this.assertExecutableQuote(quote);
    const { route } = quote;
    const { fromChainId: fromChain, toChainId: toChain } = route;

    if (route.kind === 'solana') {
      const sealevelKey = privateKeys[ProtocolType.Sealevel];
      assert(sealevelKey, 'Missing private key for Sealevel chain');
      const txHash = await solanaLayerZeroClient.executeSolanaTransfer(
        route,
        sealevelKey,
        this.getRpcUrl(fromChain),
      );
      return { txHash, fromChain, toChain };
    }

    if (route.kind === 'tron') {
      return this.executeTron(route, privateKeys);
    }
    // compose and native/legacy EVM routes all use the same execution path —
    // the sendParam already has the composeMsg and extraOptions baked in by quote()

    const key = privateKeys[ProtocolType.Ethereum];
    assert(key, 'Missing private key for EVM chain');

    const provider = new ethers.providers.StaticJsonRpcProvider(
      this.getRpcUrl(fromChain),
      fromChain,
    );
    const wallet = new ethers.Wallet(ensure0x(key), provider);

    await approveErc20IfNeeded(
      wallet,
      route.usdtContract,
      route.oftContract,
      route.sendParam.amountLD,
      this.logger,
      { mode: Erc20ApprovalMode.Infinite },
    );

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
    route: Extract<LayerZeroBridgeRoute, { kind: 'tron' }>,
    privateKeys: Partial<Record<ProtocolType, string>>,
  ): Promise<BridgeTransferResult> {
    const { fromChainId: fromChain, toChainId: toChain } = route;

    const tronKey = privateKeys[ProtocolType.Tron];
    assert(tronKey, 'Missing private key for Tron chain');
    const strippedKey = tronKey.replace(/^0x/, '');

    const chainMetadata = this.chainMetadataByChainId.get(fromChain);
    assert(
      chainMetadata,
      `No chain metadata configured for chain ${fromChain}`,
    );
    assert(
      chainMetadata.protocol === ProtocolType.Tron,
      `Expected Tron metadata for chain ${fromChain}`,
    );
    const tronSigner = await TronSigner.connectWithSigner(
      chainMetadata,
      strippedKey,
    );

    const tronWeb = tronSigner.getTronweb();
    const signerAddress = tronSigner.getSignerAddress();

    const oftContractTron = tronWeb.address.fromHex(
      '41' + route.oftContract.slice(2),
    );
    const usdtContractTron = tronWeb.address.fromHex(
      '41' + route.usdtContract.slice(2),
    );

    const { transaction: resetApprovalTx } =
      await tronWeb.transactionBuilder.triggerSmartContract(
        usdtContractTron,
        'approve(address,uint256)',
        {},
        [
          { type: 'address', value: oftContractTron },
          { type: 'uint256', value: '0' },
        ],
        signerAddress,
      );
    await tronSigner.sendAndConfirmTransaction(resetApprovalTx);

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

    assert(
      route.messagingFee.nativeFee <= BigInt(Number.MAX_SAFE_INTEGER),
      'LayerZero Tron native fee exceeds the safe integer range',
    );
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
    fromChain: number,
    toChain: number,
    _transferId?: string,
  ): Promise<BridgeTransferStatus> {
    const network = getRouteNetwork(fromChain, toChain);
    assert(network, `Unsupported route: ${fromChain} -> ${toChain}`);

    const firstHopDestination =
      network === 'compose' ? ARB_HUB_CHAIN_ID : toChain;
    const firstHopMessage = await this.getMessageForRoute(
      txHash,
      fromChain,
      firstHopDestination,
    );
    if (!firstHopMessage) return { status: 'not_found' };

    const firstHopStatus = this.evaluateMessage(
      firstHopMessage,
      network === 'compose',
    );
    if (firstHopStatus.status !== 'complete') return firstHopStatus;

    if (network !== 'compose') {
      return {
        status: 'complete',
        receivingTxHash: firstHopStatus.receivingTxHash,
        receivedAmount: 0n,
      };
    }

    const composeTxHash =
      firstHopMessage.destination?.lzCompose?.txs?.at(-1)?.txHash;
    if (!composeTxHash) {
      return {
        status: 'pending',
        substatus: 'COMPOSE_SUCCEEDED_WAITING_FOR_SECOND_HOP',
      };
    }

    const secondHopMessage = await this.getMessageForRoute(
      composeTxHash,
      ARB_HUB_CHAIN_ID,
      toChain,
    );
    if (!secondHopMessage) {
      return {
        status: 'pending',
        substatus: 'WAITING_FOR_SECOND_HOP',
      };
    }

    const secondHopStatus = this.evaluateMessage(secondHopMessage, false);
    if (secondHopStatus.status !== 'complete') return secondHopStatus;

    return {
      status: 'complete',
      receivingTxHash: secondHopStatus.receivingTxHash,
      receivedAmount: 0n,
    };
  }

  private async getMessageForRoute(
    txHash: string,
    fromChain: number,
    toChain: number,
  ): Promise<LayerZeroScanMessage | undefined> {
    const normalizedHash =
      fromChain === SOLANA_CHAIN_ID || txHash.startsWith('0x')
        ? txHash
        : `0x${txHash}`;
    const response = await this.fetchWithRetry(
      LAYERZERO_SCAN_API_URL + normalizedHash,
    );
    const responseData = LayerZeroScanResponseSchema.parse(
      await response.json(),
    );
    const messages = responseData.data ?? responseData.messages ?? [];
    const expectedSourceEid = getEID(fromChain);
    const expectedDestinationEid = getEID(toChain);

    const exactMatch = messages.find(
      (message) =>
        message.pathway?.srcEid === expectedSourceEid &&
        message.pathway.dstEid === expectedDestinationEid,
    );
    if (exactMatch) return exactMatch;

    // The previous API omitted pathway metadata. Only accept that shape when
    // the transaction unambiguously contains one message.
    if (messages.length === 1 && !messages[0].pathway) {
      return messages[0];
    }

    return undefined;
  }

  private evaluateMessage(
    message: LayerZeroScanMessage,
    requireCompose: boolean,
  ): MessageEvaluation {
    const messageStatus = getStatusName(message.status);
    if (MESSAGE_TERMINAL_FAILURES.has(messageStatus)) {
      return { status: 'failed', error: `MESSAGE_${messageStatus}` };
    }

    const destinationStatus = message.destination?.status;
    const composeStatus = message.destination?.lzCompose?.status;
    if (requireCompose && composeStatus === 'N/A') {
      return { status: 'pending', substatus: 'COMPOSE_NOT_SCHEDULED' };
    }

    if (messageStatus !== 'DELIVERED') {
      return { status: 'pending', substatus: messageStatus };
    }
    if (destinationStatus !== 'SUCCEEDED') {
      return {
        status: 'pending',
        substatus: `DESTINATION_${destinationStatus ?? 'UNKNOWN'}`,
      };
    }
    if (requireCompose && composeStatus !== 'SUCCEEDED') {
      return {
        status: 'pending',
        substatus: `COMPOSE_${composeStatus ?? 'UNKNOWN'}`,
      };
    }

    const receivingTxHash = message.destination?.tx?.txHash;
    if (!receivingTxHash) {
      return {
        status: 'pending',
        substatus: 'DESTINATION_TX_HASH_UNKNOWN',
      };
    }

    return { status: 'complete', receivingTxHash };
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

  private assertUsdtRoute(params: BridgeQuoteParams): void {
    const { fromChain, toChain, fromToken, toToken } = params;
    const expectedFromToken = getUSDTAddress(fromChain);
    const expectedToToken = getUSDTAddress(toChain);

    assert(
      this.matchesBridgeToken(fromToken, expectedFromToken),
      `LayerZero bridge is USDT-only: fromToken ${fromToken} does not match USDT ${expectedFromToken} on chain ${fromChain}`,
    );
    assert(
      this.matchesBridgeToken(toToken, expectedToToken),
      `LayerZero bridge is USDT-only: toToken ${toToken} does not match USDT ${expectedToToken} on chain ${toChain}`,
    );
  }

  private assertExecutableQuote(
    quote: BridgeQuote<LayerZeroBridgeRoute>,
  ): void {
    const { route, requestParams } = quote;
    const { fromChainId: fromChain, toChainId: toChain } = route;
    assert(
      requestParams.fromChain === fromChain &&
        requestParams.toChain === toChain,
      'LayerZero quote chain IDs do not match its request',
    );
    this.assertUsdtRoute(requestParams);

    const network = getRouteNetwork(fromChain, toChain);
    assert(network, `Unsupported route: ${fromChain} -> ${toChain}`);
    assert(route.network === network, 'LayerZero quote network mismatch');
    assert(quote.fromAmount > 0n, 'Transfer amount must be positive');

    const firstHopDestination =
      network === 'compose' ? ARB_HUB_CHAIN_ID : toChain;
    const firstHopRecipient =
      network === 'compose'
        ? addressToBytes32(MULTIHOP_COMPOSER)
        : addressToBytes32(
            requestParams.toAddress ?? requestParams.fromAddress,
          );

    if (route.kind === 'solana') {
      assert(
        fromChain === SOLANA_CHAIN_ID,
        'Solana LayerZero quote has a non-Solana origin',
      );
      assert(
        route.programId === SOLANA_OFT_PROGRAM &&
          route.store === SOLANA_OFT_STORE &&
          route.tokenMint === getUSDTAddress(fromChain),
        'Solana LayerZero quote contains an untrusted deployment',
      );
      assert(
        route.destinationEid === getEID(firstHopDestination) &&
          route.toBytes32.toLowerCase() === firstHopRecipient.toLowerCase() &&
          route.amountLd === quote.fromAmount,
        'Solana LayerZero quote transfer parameters mismatch',
      );
      return;
    }

    const expectedKind = fromChain === TRON_CHAIN_ID ? 'tron' : 'evm';
    assert(
      route.kind === expectedKind,
      `LayerZero quote kind ${route.kind} does not match origin chain`,
    );
    const expectedOft = getOFTContractForRoute(fromChain, toChain).address;
    assert(
      this.matchesBridgeToken(route.oftContract, expectedOft) &&
        this.matchesBridgeToken(route.usdtContract, getUSDTAddress(fromChain)),
      'LayerZero quote contains an untrusted token or OFT contract',
    );
    assert(
      route.sendParam.dstEid === getEID(firstHopDestination) &&
        route.sendParam.to.toLowerCase() === firstHopRecipient.toLowerCase() &&
        route.sendParam.amountLD === quote.fromAmount,
      'LayerZero quote transfer parameters mismatch',
    );
  }

  private matchesBridgeToken(
    actualToken: string,
    expectedToken: string,
  ): boolean {
    if (/^0x/i.test(actualToken) && /^0x/i.test(expectedToken)) {
      return actualToken.toLowerCase() === expectedToken.toLowerCase();
    }

    return actualToken === expectedToken;
  }
}
