import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getMint } from '@solana/spl-token';
import { ethers } from 'ethers';
import type { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';

import {
  type ChainMap,
  type ChainMetadata,
  submitEvmLikeTransaction,
} from '@hyperlane-xyz/sdk';
import {
  TronJsonRpcProvider,
  TronWallet,
} from '@hyperlane-xyz/tron-sdk/runtime';
import {
  ProtocolType,
  TransactionSubmission,
  addressToBytesTron,
  assert,
  bufferToBase58,
} from '@hyperlane-xyz/utils';

import type {
  BridgeExecutionOptions,
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import {
  DLN_FORWARDER,
  validateDeBridgeForwarderDeployment,
} from './deBridgeForwarderValidation.js';
import {
  DLN_EVM_SOURCE,
  DLN_TRON_SOURCE,
  DLN_SOLANA_SOURCE,
  validateDeBridgeEvmTransaction,
  validateDeBridgeSolanaInstructions,
} from './deBridgeValidation.js';
import {
  type DlnOrder,
  dlnSolanaEvents,
  evmDlnOrder,
  solanaCreatedOrder,
} from './deBridgeSettlement.js';
import { parseSolanaPrivateKey } from '../utils/solanaKeyParser.js';
import { approveErc20IfNeeded } from './erc20Approve.js';
import {
  DEBRIDGE_API_BASE,
  DEBRIDGE_STATUS_API,
  DEBRIDGE_TOOL,
  DEBRIDGE_TRON_CHAIN_ID,
  type DeBridgeCreateTxResponse,
  type DeBridgeQuoteResponse,
  type DeBridgeTokenEstimation,
  formatAddressForDebridge,
  hyperlaneChainIdToDebridge,
  isDebridgeSolanaChain,
  isDebridgeTronChain,
  parseDeBridgeCreateTxResponse,
  parseDeBridgeOrderStatusResponse,
  parseDeBridgeQuoteResponse,
} from './deBridgeUtils.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TRANSACTION_AGE_MS = 30_000;
const MAX_PREPARATION_ATTEMPTS = 3;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_FEE_PERCENT = 10;
const MAX_PERCENT = 100;
const BASIS_POINTS_PER_PERCENT = 100;
const BASIS_POINTS_DENOMINATOR = 10_000n;

export interface DeBridgeBridgeConfig {
  apiUrl?: string;
  statusApiUrl?: string;
  chainMetadata?: ChainMap<ChainMetadata>;
  maxFeePercent?: number;
}

export class DeBridgeBridge implements IExternalBridge {
  readonly externalBridgeId = DEBRIDGE_TOOL;
  readonly logger: Logger;

  private readonly apiUrl: string;
  private readonly statusApiUrl: string;
  private readonly chainMetadataByChainId: Map<number, ChainMetadata>;
  private readonly maxFeeBps: number;

  constructor(config: DeBridgeBridgeConfig, logger: Logger) {
    this.logger = logger;
    this.apiUrl = this.validateApiUrl(config.apiUrl ?? DEBRIDGE_API_BASE);
    this.statusApiUrl = this.validateApiUrl(
      config.statusApiUrl ?? DEBRIDGE_STATUS_API,
    );

    const maxFeePercent = config.maxFeePercent ?? DEFAULT_MAX_FEE_PERCENT;
    assert(
      Number.isFinite(maxFeePercent) &&
        maxFeePercent >= 0 &&
        maxFeePercent <= MAX_PERCENT,
      `maxFeePercent must be between 0 and ${MAX_PERCENT}`,
    );
    const maxFeeBps = maxFeePercent * BASIS_POINTS_PER_PERCENT;
    assert(
      Number.isInteger(maxFeeBps),
      'maxFeePercent must have at most two decimal places',
    );
    this.maxFeeBps = maxFeeBps;

    this.chainMetadataByChainId = new Map();
    for (const metadata of Object.values(config.chainMetadata ?? {})) {
      if (
        metadata.chainId === undefined ||
        (metadata.protocol !== ProtocolType.Ethereum &&
          metadata.protocol !== ProtocolType.Tron &&
          metadata.protocol !== ProtocolType.Sealevel)
      ) {
        continue;
      }

      const chainId = Number(metadata.chainId);
      assert(
        !this.chainMetadataByChainId.has(chainId),
        `Duplicate chain metadata for chain ID ${chainId}`,
      );
      this.chainMetadataByChainId.set(chainId, metadata);
    }
  }

  async quote(params: BridgeQuoteParams): Promise<BridgeQuote> {
    this.validateQuoteParams(params);

    const srcDebridgeChainId = hyperlaneChainIdToDebridge(params.fromChain);
    const dstDebridgeChainId = hyperlaneChainIdToDebridge(params.toChain);
    const srcToken = formatAddressForDebridge(
      params.fromToken,
      srcDebridgeChainId,
    );
    const dstToken = formatAddressForDebridge(
      params.toToken,
      dstDebridgeChainId,
    );
    formatAddressForDebridge(params.fromAddress, srcDebridgeChainId);
    if (params.toAddress) {
      formatAddressForDebridge(params.toAddress, dstDebridgeChainId);
    }

    const url = this.buildApiUrl('/dln/order/quote', {
      srcChainId: srcDebridgeChainId.toString(),
      srcChainTokenIn: srcToken,
      srcChainTokenInAmount: params.fromAmount?.toString() ?? 'auto',
      dstChainId: dstDebridgeChainId.toString(),
      dstChainTokenOut: dstToken,
      dstChainTokenOutAmount: params.toAmount?.toString() ?? 'auto',
      prependOperatingExpenses: 'false',
    });

    this.logger.debug(
      {
        fromChain: params.fromChain,
        toChain: params.toChain,
        srcDebridgeChainId,
        dstDebridgeChainId,
      },
      'Requesting deBridge quote',
    );

    const response = await this.fetchWithRetry(url);
    const body: unknown = await response.json();
    const data = parseDeBridgeQuoteResponse(body);
    this.validateEstimation(data, params);
    this.assertFeeWithinLimit(data, params.fromChain, params.toChain);

    const fromAmount = BigInt(data.estimation.srcChainTokenIn.amount);
    const toAmount = BigInt(data.estimation.dstChainTokenOut.amount);
    const feeCosts =
      BigInt(data.fixFee ?? '0') + BigInt(data.protocolFee ?? '0');

    return {
      id: uuidv4(),
      tool: DEBRIDGE_TOOL,
      fromAmount,
      toAmount,
      toAmountMin: toAmount,
      executionDuration: 60,
      gasCosts: 0n,
      feeCosts,
      route: data,
      requestParams: { ...params },
    };
  }

  execute(
    quote: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
    options?: BridgeExecutionOptions,
  ): Promise<BridgeTransferResult> {
    return new TransactionSubmission(options).run(() =>
      this.executeOrder(quote, privateKeys, options),
    );
  }

  private async executeOrder(
    quote: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
    options?: BridgeExecutionOptions,
  ): Promise<BridgeTransferResult> {
    const sourceChain = hyperlaneChainIdToDebridge(
      quote.requestParams.fromChain,
    );
    const protocol = this.getProtocol(sourceChain);
    const privateKey = privateKeys[protocol];
    assert(privateKey, `Missing private key for ${protocol} chain`);
    this.deriveAndValidateSender(
      protocol,
      privateKey,
      quote.requestParams.fromAddress,
      sourceChain,
    );
    for (let attempt = 0; attempt < MAX_PREPARATION_ATTEMPTS; attempt++) {
      const prepared = await this.prepare(quote);
      const result =
        protocol === ProtocolType.Sealevel
          ? await this.executeSolana(
              privateKey,
              prepared.response,
              quote,
              options,
              prepared.preparedAt,
            )
          : await this.executeEvmLike(
              protocol,
              privateKey,
              prepared.response,
              quote,
              options,
              prepared.preparedAt,
            );
      if (result) return result;
      // Only preparation/approval occurred. A submission error never reaches
      // this retry: TransactionSubmission retains the exposed source identity.
    }
    throw new Error(
      'deBridge transaction expired repeatedly during preparation',
    );
  }

  /** Fetch and validate an executable unsigned order without keys or approvals. */
  async prepare(
    quote: BridgeQuote,
  ): Promise<{ response: DeBridgeCreateTxResponse; preparedAt: number }> {
    assert(quote.tool === DEBRIDGE_TOOL, 'Quote was not created by deBridge');
    assert(quote.fromAmount > 0n, 'Quote fromAmount must be positive');
    assert(quote.toAmountMin > 0n, 'Quote toAmountMin must be positive');
    const quotedRoute = parseDeBridgeQuoteResponse(quote.route);
    const params = quote.requestParams;
    this.validateQuoteParams(params);
    this.validateEstimation(quotedRoute, params);
    assert(
      BigInt(quotedRoute.estimation.srcChainTokenIn.amount) ===
        quote.fromAmount,
      'Quote route fromAmount does not match quote',
    );
    assert(
      BigInt(quotedRoute.estimation.dstChainTokenOut.amount) === quote.toAmount,
      'Quote route toAmount does not match quote',
    );

    const srcDebridgeChainId = hyperlaneChainIdToDebridge(params.fromChain);
    const dstDebridgeChainId = hyperlaneChainIdToDebridge(params.toChain);
    assert(params.toAddress, 'toAddress is required for deBridge execution');
    const senderAddress = formatAddressForDebridge(
      params.fromAddress,
      srcDebridgeChainId,
    );
    const recipientAddress = formatAddressForDebridge(
      params.toAddress,
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

    const createTxUrl = this.buildApiUrl('/dln/order/create-tx', {
      srcChainId: srcDebridgeChainId.toString(),
      srcChainTokenIn: srcToken,
      srcChainTokenInAmount: quote.fromAmount.toString(),
      dstChainId: dstDebridgeChainId.toString(),
      dstChainTokenOut: dstToken,
      dstChainTokenOutAmount: 'auto',
      dstChainTokenOutRecipient: recipientAddress,
      senderAddress,
      srcChainOrderAuthorityAddress: senderAddress,
      srcAllowedCancelBeneficiary: senderAddress,
      dstChainOrderAuthorityAddress: recipientAddress,
      prependOperatingExpenses: 'false',
    });

    this.logger.info(
      {
        fromChain: params.fromChain,
        toChain: params.toChain,
        amount: quote.fromAmount.toString(),
        sender: senderAddress,
        recipient: recipientAddress,
      },
      'Creating deBridge order transaction',
    );

    const preparedAt = Date.now();
    const response = await this.fetchWithRetry(createTxUrl);
    const body: unknown = await response.json();
    const createTx = parseDeBridgeCreateTxResponse(body);
    this.validateEstimation(createTx, params, {
      exactFromAmount: quote.fromAmount,
      minimumToAmount: quote.toAmountMin,
    });
    this.assertFeeWithinLimit(createTx, params.fromChain, params.toChain);

    await this.validatePreparedOrder(quote, createTx);
    assert(
      Date.now() - preparedAt < MAX_TRANSACTION_AGE_MS,
      'deBridge transaction expired during preparation',
    );
    return { response: createTx, preparedAt };
  }

  private getEvmProvider(chainId: number): ethers.providers.JsonRpcProvider {
    return this.getProtocol(hyperlaneChainIdToDebridge(chainId)) ===
      ProtocolType.Tron
      ? new TronJsonRpcProvider(this.getRpcUrl(chainId))
      : new ethers.providers.StaticJsonRpcProvider(
          this.getRpcUrl(chainId),
          chainId,
        );
  }

  private async tokenDecimals(chainId: number, token: string): Promise<number> {
    const protocol = this.getProtocol(hyperlaneChainIdToDebridge(chainId));
    if (protocol === ProtocolType.Sealevel) {
      return (
        await getMint(
          new Connection(this.getRpcUrl(chainId)),
          new PublicKey(token),
        )
      ).decimals;
    }
    const address = this.getEvmLikeAddress(token, protocol);
    if (address === ethers.constants.AddressZero) {
      const decimals =
        this.chainMetadataByChainId.get(chainId)?.nativeToken?.decimals;
      assert(
        decimals !== undefined,
        `Missing native token decimals for chain ${chainId}`,
      );
      return decimals;
    }
    return new ethers.Contract(
      address,
      ['function decimals() view returns(uint8)'],
      this.getEvmProvider(chainId),
    ).decimals();
  }

  private async validatePreparedOrder(
    quote: BridgeQuote,
    response: DeBridgeCreateTxResponse,
  ): Promise<void> {
    const { fromChain, toChain, fromToken, toToken, fromAddress } =
      quote.requestParams;
    const protocol = this.getProtocol(hyperlaneChainIdToDebridge(fromChain));
    if (protocol === ProtocolType.Sealevel) {
      await this.validateSolanaTransaction(quote, response);
    } else {
      assert(response.tx.to, 'deBridge create-tx response is missing tx.to');
      validateDeBridgeEvmTransaction(quote, response.tx.to, response.tx.data);
      const provider = this.getEvmProvider(fromChain);
      if (response.tx.to.toLowerCase() === DLN_FORWARDER.toLowerCase())
        await validateDeBridgeForwarderDeployment(provider, response.tx.data);
      const source =
        protocol === ProtocolType.Tron ? DLN_TRON_SOURCE : DLN_EVM_SOURCE;
      const fee: ethers.BigNumber = await new ethers.Contract(
        source,
        ['function globalFixedNativeFee() view returns(uint88)'],
        provider,
      ).globalFixedNativeFee();
      const native =
        this.getEvmLikeAddress(fromToken, protocol) ===
        ethers.constants.AddressZero;
      assert(
        BigInt(response.fixFee) === BigInt(fee.toString()),
        'deBridge fixed fee does not match source contract',
      );
      assert(
        response.tx.value !== undefined &&
          BigInt(response.tx.value) ===
            BigInt(fee.toString()) + (native ? quote.fromAmount : 0n),
        'deBridge transaction value does not match expected contract fee and input',
      );
    }
    const [sourceDecimals, destinationDecimals] = await Promise.all([
      this.tokenDecimals(fromChain, fromToken),
      this.tokenDecimals(toChain, toToken),
    ]);
    assert(
      response.estimation.srcChainTokenIn.decimals === sourceDecimals &&
        response.estimation.dstChainTokenOut.decimals === destinationDecimals,
      'deBridge token decimals do not match chain data',
    );
    this.assertFeeWithinLimit(response, fromChain, toChain);
    this.logger.debug(
      { fromChain, toChain, sender: fromAddress },
      'Validated unsigned deBridge order',
    );
  }

  private async validateSolanaTransaction(
    quote: BridgeQuote,
    response: DeBridgeCreateTxResponse,
  ): Promise<VersionedTransaction> {
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(response.tx.data.slice(2), 'hex'),
    );
    const signer = new PublicKey(quote.requestParams.fromAddress);
    assert(
      transaction.message.header.numRequiredSignatures === 1,
      'deBridge Solana transaction must require exactly one signer',
    );
    assert(
      transaction.message.staticAccountKeys[0]?.equals(signer),
      'deBridge Solana transaction signer does not match inventory signer',
    );
    const connection = new Connection(
      this.getRpcUrl(quote.requestParams.fromChain),
    );
    const addressLookupTableAccounts = await Promise.all(
      transaction.message.addressTableLookups.map(async (lookup) => {
        const { value } = await connection.getAddressLookupTable(
          lookup.accountKey,
        );
        assert(value, 'deBridge Solana address lookup table was not found');
        return value;
      }),
    );
    const { instructions } = TransactionMessage.decompile(transaction.message, {
      addressLookupTableAccounts,
    });
    validateDeBridgeSolanaInstructions(quote, signer, instructions);
    return transaction;
  }

  async getStatus(
    txHash: string,
    fromChain: number,
    toChain: number,
    transferId?: string,
  ): Promise<BridgeTransferStatus> {
    assert(
      transferId && /^0x[0-9a-fA-F]{64}$/.test(transferId),
      'A valid deBridge order ID is required to check transfer status',
    );
    const url = new URL(
      `/v1.0/dln/order/${encodeURIComponent(transferId)}/status`,
      this.statusApiUrl,
    ).toString();

    this.logger.debug(
      { txHash, orderId: transferId },
      'Checking deBridge order',
    );
    const response = await this.fetchWithRetry(url);
    const body: unknown = await response.json();
    const data = parseDeBridgeOrderStatusResponse(body);
    assert(
      data.orderId.toLowerCase() === transferId.toLowerCase(),
      `deBridge status returned unexpected order ID ${data.orderId}`,
    );

    switch (data.status) {
      case 'None':
        return { status: 'not_found' };
      case 'Created':
        return { status: 'pending', substatus: data.status };
      case 'Fulfilled':
      case 'SentUnlock':
      case 'ClaimedUnlock': {
        const receivingTxHash =
          data.fulfilledDstEventMetadata?.transactionHash?.stringValue;
        if (!receivingTxHash)
          return {
            status: 'pending',
            substatus: 'Missing destination transaction',
          };
        const receivedAmount = await this.verifySettlement(
          txHash,
          fromChain,
          receivingTxHash,
          toChain,
          transferId,
        );
        if (receivedAmount === undefined)
          return {
            status: 'pending',
            substatus: 'Awaiting verified source and destination finality',
          };
        return { status: 'complete', receivingTxHash, receivedAmount };
      }
      case 'OrderCancelled':
      case 'SentOrderCancel':
      case 'ClaimedOrderCancel':
        return { status: 'failed', error: data.status };
      default: {
        const exhaustiveStatus: never = data.status;
        throw new Error(`Unsupported deBridge status: ${exhaustiveStatus}`);
      }
    }
  }

  private async finalizedReceipt(
    chainId: number,
    hash: string,
  ): Promise<ethers.providers.TransactionReceipt | undefined> {
    const provider = this.getEvmProvider(chainId);
    const normalized = hash.startsWith('0x') ? hash : `0x${hash}`;
    assert(
      /^0x[0-9a-fA-F]{64}$/.test(normalized),
      'Invalid DLN settlement transaction hash',
    );
    const receipt = await provider.getTransactionReceipt(normalized);
    if (!receipt || receipt.status !== 1) return undefined;
    const blocks = this.chainMetadataByChainId.get(chainId)?.blocks;
    const confirmations = Math.max(
      blocks?.confirmations ?? 1,
      typeof blocks?.reorgPeriod === 'number' ? blocks.reorgPeriod : 1,
    );
    if (receipt.confirmations < confirmations) return undefined;
    if (provider instanceof TronJsonRpcProvider) {
      if (receipt.blockNumber > (await provider.getFinalizedBlockNumber()))
        return undefined;
    } else if (typeof blocks?.reorgPeriod === 'string') {
      const block = await provider.getBlock(blocks.reorgPeriod);
      if (!block || receipt.blockNumber > block.number) return undefined;
    }
    return receipt;
  }

  private async verifySettlement(
    sourceHash: string,
    fromChain: number,
    destinationHash: string,
    toChain: number,
    orderId: string,
  ): Promise<bigint | undefined> {
    const sourceProtocol = this.getProtocol(
      hyperlaneChainIdToDebridge(fromChain),
    );
    let order: DlnOrder;
    if (sourceProtocol === ProtocolType.Sealevel) {
      const tx = await new Connection(this.getRpcUrl(fromChain)).getTransaction(
        sourceHash,
        { commitment: 'finalized', maxSupportedTransactionVersion: 0 },
      );
      if (!tx?.meta || tx.meta.err) return undefined;
      assert(tx.meta.logMessages, 'Missing DLN Solana source logs');
      order = solanaCreatedOrder(
        tx.meta.logMessages,
        DLN_SOLANA_SOURCE.toBase58(),
        orderId,
      );
    } else {
      const receipt = await this.finalizedReceipt(fromChain, sourceHash);
      if (!receipt) return undefined;
      order = evmDlnOrder(
        receipt.logs,
        sourceProtocol === ProtocolType.Tron ? DLN_TRON_SOURCE : DLN_EVM_SOURCE,
        'CreatedOrder',
        orderId,
      );
    }
    assert(
      order.giveChainId === BigInt(hyperlaneChainIdToDebridge(fromChain)) &&
        order.takeChainId === BigInt(hyperlaneChainIdToDebridge(toChain)),
      'DLN settlement route mismatch',
    );
    assert(order.takeAmount > 0n, 'DLN settlement amount must be positive');
    const destinationProtocol = this.getProtocol(
      hyperlaneChainIdToDebridge(toChain),
    );
    if (destinationProtocol === ProtocolType.Sealevel) {
      const tx = await new Connection(this.getRpcUrl(toChain)).getTransaction(
        destinationHash,
        { commitment: 'finalized', maxSupportedTransactionVersion: 0 },
      );
      if (!tx?.meta || tx.meta.err) return undefined;
      assert(tx.meta.logMessages, 'Missing DLN Solana destination logs');
      const events = dlnSolanaEvents(
        tx.meta.logMessages,
        'dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo',
        'Fulfilled',
      );
      assert(
        events.filter(
          (data) =>
            data.length === 64 &&
            ethers.utils.hexlify(data.subarray(0, 32)) ===
              orderId.toLowerCase(),
        ).length === 1,
        'DLN destination order ID mismatch',
      );
      const mint = new PublicKey(ethers.utils.arrayify(order.takeTokenAddress));
      const recipient = new PublicKey(ethers.utils.arrayify(order.receiverDst));
      const account = getAssociatedTokenAddressSync(mint, recipient);
      const keys = tx.transaction.message.getAccountKeys({
        accountKeysFromLookups: tx.meta.loadedAddresses,
      });
      const balance = (balances: typeof tx.meta.postTokenBalances) => {
        const match = balances?.find(
          (b) =>
            b.mint === mint.toBase58() &&
            keys.get(b.accountIndex)?.equals(account),
        );
        return match ? BigInt(match.uiTokenAmount.amount) : 0n;
      };
      assert(
        balance(tx.meta.postTokenBalances) -
          balance(tx.meta.preTokenBalances) >=
          order.takeAmount,
        'DLN destination received less than the committed amount',
      );
    } else {
      const receipt = await this.finalizedReceipt(toChain, destinationHash);
      if (!receipt) return undefined;
      const destination =
        destinationProtocol === ProtocolType.Tron
          ? ethers.utils.hexlify(
              addressToBytesTron('TXCbCdoHjg28g36X5jnWTP88mRzx54RqXp'),
            )
          : '0xE7351Fd770A37282b91D153Ee690B63579D6dd7f';
      evmDlnOrder(receipt.logs, destination, 'FulfilledOrder', orderId);
      if (order.takeTokenAddress === ethers.constants.AddressZero) {
        // FulfilledOrder contains the original amount even after an authorized
        // take-amount reduction. Native payouts have no ERC20 credit event.
        const patch: ethers.BigNumber = await new ethers.Contract(
          destination,
          ['function takePatches(bytes32) view returns(uint256)'],
          this.getEvmProvider(toChain),
        ).takePatches(orderId, { blockTag: receipt.blockNumber });
        assert(patch.isZero(), 'DLN native destination amount was reduced');
      } else {
        const recipient = ethers.utils
          .hexZeroPad(order.receiverDst, 32)
          .toLowerCase();
        const received = receipt.logs
          .filter(
            (log) =>
              log.address.toLowerCase() ===
                order.takeTokenAddress.toLowerCase() &&
              log.topics.length === 3 &&
              log.topics[0] ===
                ethers.utils.id('Transfer(address,address,uint256)'),
          )
          .reduce(
            (amount, log) =>
              amount +
              (log.topics[2].toLowerCase() === recipient
                ? BigInt(log.data)
                : 0n) -
              (log.topics[1].toLowerCase() === recipient
                ? BigInt(log.data)
                : 0n),
            0n,
          );
        assert(
          received >= order.takeAmount,
          'DLN destination received less than the committed amount',
        );
      }
    }
    return order.takeAmount;
  }

  private async executeEvmLike(
    protocol: ProtocolType.Ethereum | ProtocolType.Tron,
    privateKey: string,
    createTx: DeBridgeCreateTxResponse,
    quote: BridgeQuote,
    options: BridgeExecutionOptions | undefined,
    preparedAt: number,
  ): Promise<BridgeTransferResult | undefined> {
    const { tx, fixFee, orderId } = createTx;
    assert(tx.to, 'deBridge create-tx response is missing tx.to');
    assert(tx.value, 'deBridge create-tx response is missing tx.value');
    assert(
      ethers.utils.isAddress(tx.to),
      `deBridge returned invalid transaction target: ${tx.to}`,
    );

    const rpcUrl = this.getRpcUrl(quote.requestParams.fromChain);
    const wallet =
      protocol === ProtocolType.Tron
        ? new TronWallet(privateKey, rpcUrl)
        : new ethers.Wallet(
            privateKey,
            new ethers.providers.StaticJsonRpcProvider(
              rpcUrl,
              quote.requestParams.fromChain,
            ),
          );
    const tokenAddress = this.getEvmLikeAddress(
      quote.requestParams.fromToken,
      protocol,
    );
    const isNativeToken =
      tokenAddress === ethers.constants.AddressZero.toLowerCase();
    const expectedValue =
      BigInt(fixFee) + (isNativeToken ? quote.fromAmount : 0n);
    assert(
      BigInt(tx.value) === expectedValue,
      `deBridge transaction value ${tx.value} does not match expected ${expectedValue}`,
    );

    if (!isNativeToken) {
      await approveErc20IfNeeded(
        wallet,
        tokenAddress,
        tx.to,
        quote.fromAmount,
        this.logger,
        { onApproval: options?.onApproval },
      );
    }

    if (Date.now() - preparedAt >= MAX_TRANSACTION_AGE_MS) return undefined;
    await this.validatePreparedOrder(quote, createTx);
    if (Date.now() - preparedAt >= MAX_TRANSACTION_AGE_MS) return undefined;

    this.logger.info(
      {
        from: wallet.address,
        to: tx.to,
        fromChain: quote.requestParams.fromChain,
        orderId,
      },
      `Sending deBridge ${protocol} transaction`,
    );
    await options?.onTransferId?.(orderId);
    const transaction = await submitEvmLikeTransaction(
      wallet,
      {
        to: tx.to,
        data: tx.data,
        value: ethers.BigNumber.from(tx.value),
      },
      options,
    );

    return {
      txHash: transaction.hash,
      fromChain: quote.requestParams.fromChain,
      toChain: quote.requestParams.toChain,
      transferId: orderId,
    };
  }

  private async executeSolana(
    privateKey: string,
    createTx: DeBridgeCreateTxResponse,
    quote: BridgeQuote,
    options: BridgeExecutionOptions | undefined,
    preparedAt: number,
  ): Promise<BridgeTransferResult | undefined> {
    const keypair = Keypair.fromSecretKey(parseSolanaPrivateKey(privateKey));
    const transaction = await this.validateSolanaTransaction(quote, createTx);
    const connection = new Connection(
      this.getRpcUrl(quote.requestParams.fromChain),
    );
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.message.recentBlockhash = blockhash;
    if (Date.now() - preparedAt >= MAX_TRANSACTION_AGE_MS) return undefined;
    transaction.sign([keypair]);

    await options?.onTransferId?.(createTx.orderId);
    const signature = await new TransactionSubmission(options).submit(
      () => connection.sendTransaction(transaction),
      (signature) => signature,
      bufferToBase58(Buffer.from(transaction.signatures[0])),
    );

    return {
      txHash: signature,
      fromChain: quote.requestParams.fromChain,
      toChain: quote.requestParams.toChain,
      transferId: createTx.orderId,
    };
  }

  private deriveAndValidateSender(
    protocol: ProtocolType.Ethereum | ProtocolType.Tron | ProtocolType.Sealevel,
    privateKey: string,
    configuredAddress: string,
    srcDebridgeChainId: number,
  ): string {
    let derivedAddress: string;
    switch (protocol) {
      case ProtocolType.Ethereum:
      case ProtocolType.Tron:
        derivedAddress = new ethers.Wallet(privateKey).address;
        break;
      case ProtocolType.Sealevel:
        derivedAddress = Keypair.fromSecretKey(
          parseSolanaPrivateKey(privateKey),
        ).publicKey.toBase58();
        break;
      default: {
        const exhaustiveProtocol: never = protocol;
        throw new Error(`Unsupported source protocol: ${exhaustiveProtocol}`);
      }
    }

    const formattedDerived = formatAddressForDebridge(
      derivedAddress,
      srcDebridgeChainId,
    );
    const formattedConfigured = formatAddressForDebridge(
      configuredAddress,
      srcDebridgeChainId,
    );
    const matches =
      protocol === ProtocolType.Ethereum
        ? formattedDerived.toLowerCase() === formattedConfigured.toLowerCase()
        : formattedDerived === formattedConfigured;
    assert(matches, `${protocol} private key does not match inventory signer`);
    return formattedDerived;
  }

  private validateQuoteParams(params: BridgeQuoteParams): void {
    assert(
      params.fromChain !== params.toChain,
      'Source and destination must differ',
    );
    assert(
      !(params.fromAmount !== undefined && params.toAmount !== undefined),
      'Cannot specify both fromAmount and toAmount',
    );
    assert(
      params.fromAmount !== undefined || params.toAmount !== undefined,
      'Must specify either fromAmount or toAmount',
    );
    if (params.fromAmount !== undefined) {
      assert(params.fromAmount > 0n, 'fromAmount must be positive');
    }
    if (params.toAmount !== undefined) {
      assert(params.toAmount > 0n, 'toAmount must be positive');
    }
  }

  private validateEstimation(
    response: DeBridgeQuoteResponse,
    params: BridgeQuoteParams,
    limits?: { exactFromAmount: bigint; minimumToAmount: bigint },
  ): void {
    const srcChainId = hyperlaneChainIdToDebridge(params.fromChain);
    const dstChainId = hyperlaneChainIdToDebridge(params.toChain);
    const { srcChainTokenIn, dstChainTokenOut } = response.estimation;

    assert(
      srcChainTokenIn.chainId === srcChainId,
      `deBridge returned unexpected source chain ${srcChainTokenIn.chainId}`,
    );
    assert(
      dstChainTokenOut.chainId === dstChainId,
      `deBridge returned unexpected destination chain ${dstChainTokenOut.chainId}`,
    );
    assert(
      this.addressesEqual(
        srcChainTokenIn.address,
        params.fromToken,
        srcChainId,
      ),
      `deBridge returned unexpected source token ${srcChainTokenIn.address}`,
    );
    assert(
      this.addressesEqual(dstChainTokenOut.address, params.toToken, dstChainId),
      `deBridge returned unexpected destination token ${dstChainTokenOut.address}`,
    );

    const fromAmount = BigInt(srcChainTokenIn.amount);
    const toAmount = BigInt(dstChainTokenOut.amount);
    assert(fromAmount > 0n, 'deBridge source amount must be positive');
    assert(toAmount > 0n, 'deBridge destination amount must be positive');
    const exactFromAmount = limits?.exactFromAmount ?? params.fromAmount;
    if (exactFromAmount !== undefined) {
      assert(
        fromAmount === exactFromAmount,
        `deBridge returned unexpected source amount ${fromAmount}`,
      );
    }
    const minimumToAmount = limits?.minimumToAmount ?? params.toAmount;
    if (minimumToAmount !== undefined) {
      assert(
        toAmount >= minimumToAmount,
        `deBridge destination amount ${toAmount} is below required ${minimumToAmount}`,
      );
    }
  }

  private assertFeeWithinLimit(
    response: DeBridgeQuoteResponse,
    fromChain: number,
    toChain: number,
  ): void {
    const { srcChainTokenIn, dstChainTokenOut } = response.estimation;
    const commonDecimals = Math.max(
      srcChainTokenIn.decimals,
      dstChainTokenOut.decimals,
    );
    const sourceAmount = this.scaleAmount(srcChainTokenIn, commonDecimals);
    const destinationAmount = this.scaleAmount(
      dstChainTokenOut,
      commonDecimals,
    );
    const feeAmount =
      sourceAmount > destinationAmount ? sourceAmount - destinationAmount : 0n;
    const feeBps =
      feeAmount === 0n
        ? 0n
        : (feeAmount * BASIS_POINTS_DENOMINATOR + sourceAmount - 1n) /
          sourceAmount;

    this.logger.info(
      {
        fromChain,
        toChain,
        feeBps: feeBps.toString(),
        maxFeeBps: this.maxFeeBps,
      },
      'deBridge fee guard',
    );
    assert(
      feeBps <= BigInt(this.maxFeeBps),
      `deBridge fee too high: ${feeBps} bps. Max allowed: ${this.maxFeeBps} bps`,
    );
  }

  private scaleAmount(
    estimation: DeBridgeTokenEstimation,
    decimals: number,
  ): bigint {
    return (
      BigInt(estimation.amount) * 10n ** BigInt(decimals - estimation.decimals)
    );
  }

  private addressesEqual(
    first: string,
    second: string,
    debridgeChainId: number,
  ): boolean {
    const formattedFirst = formatAddressForDebridge(first, debridgeChainId);
    const formattedSecond = formatAddressForDebridge(second, debridgeChainId);
    return isDebridgeSolanaChain(debridgeChainId) ||
      isDebridgeTronChain(debridgeChainId)
      ? formattedFirst === formattedSecond
      : formattedFirst.toLowerCase() === formattedSecond.toLowerCase();
  }

  private getEvmLikeAddress(
    address: string,
    protocol: ProtocolType.Ethereum | ProtocolType.Tron,
  ): string {
    if (protocol === ProtocolType.Ethereum) {
      assert(
        ethers.utils.isAddress(address),
        `Invalid EVM address: ${address}`,
      );
      return address.toLowerCase();
    }

    const formatted = formatAddressForDebridge(address, DEBRIDGE_TRON_CHAIN_ID);
    return ethers.utils.hexlify(addressToBytesTron(formatted)).toLowerCase();
  }

  private getProtocol(
    debridgeChainId: number,
  ): ProtocolType.Ethereum | ProtocolType.Tron | ProtocolType.Sealevel {
    if (isDebridgeTronChain(debridgeChainId)) return ProtocolType.Tron;
    if (isDebridgeSolanaChain(debridgeChainId)) return ProtocolType.Sealevel;
    return ProtocolType.Ethereum;
  }

  private getRpcUrl(chainId: number): string {
    const rpcUrl = this.chainMetadataByChainId.get(chainId)?.rpcUrls?.[0]?.http;
    assert(rpcUrl, `No RPC URL configured for chain ${chainId}`);
    return rpcUrl;
  }

  private validateApiUrl(rawUrl: string): string {
    const url = new URL(rawUrl);
    assert(url.protocol === 'https:', 'deBridge API URL must use HTTPS');
    return url.toString();
  }

  private buildApiUrl(path: string, params: Record<string, string>): string {
    const url = new URL(`/v1.0${path}`, this.apiUrl);
    url.search = new URLSearchParams(params).toString();
    return url.toString();
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, BASE_BACKOFF_MS * 2 ** (attempt - 1)),
        );
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          const body = await response.text();
          throw new Error(`deBridge HTTP ${response.status}: ${body}`);
        }
        if (response.ok) return response;
        lastError = new Error(`deBridge HTTP ${response.status}`);
      } catch (error) {
        if (
          error instanceof Error &&
          /^deBridge HTTP 4\d\d:/.test(error.message)
        ) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError ?? new Error('deBridge request exhausted retries');
  }
}
