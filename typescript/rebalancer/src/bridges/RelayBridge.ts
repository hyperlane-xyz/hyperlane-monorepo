import {
  BigNumber,
  Contract,
  Wallet,
  constants,
  utils,
  type providers,
} from 'ethers';
import type { Logger } from 'pino';
import { z } from 'zod';

import {
  ChainStatus,
  MultiProvider,
  submitEvmLikeTransaction,
  type ChainMap,
  type ChainMetadata,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  TransactionSubmission,
  assert,
} from '@hyperlane-xyz/utils';

import { ExternalBridgeType } from '../config/types.js';
import type {
  BridgeExecutionOptions,
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import { minimumOutputForLoss } from '../utils/quoteBudget.js';
import { isReceiptFinalized } from '../utils/receiptFinality.js';

import { approveErc20IfNeeded } from './erc20Approve.js';
import {
  RelayAddressSchema,
  RelayClient,
  RelayHashSchema,
  RelayQuoteResponseSchema,
  RelayRequestError,
  RelayStatus,
  RelayStepId,
  RelayTradeType,
  type RelayQuoteResponse,
} from './RelayClient.js';

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
const ERC20_INTERFACE = new utils.Interface(ERC20_ABI);
const TRANSFER_TOPIC = ERC20_INTERFACE.getEventTopic('Transfer');
const MAX_PREPARATION_AGE_MS = 30_000;
const POSITIVE_AMOUNT = z.string().regex(/^[1-9][0-9]*$/);
const RelayBridgeRouteSchema = z.object({
  response: RelayQuoteResponseSchema,
  preparedAt: z.number().int().nonnegative(),
});

export type RelayBridgeRoute = z.infer<typeof RelayBridgeRouteSchema>;

const TransferIdentitySchema = z.object({
  version: z.literal(1),
  requestId: RelayHashSchema,
  fromChain: z.number().int().positive(),
  toChain: z.number().int().positive(),
  fromToken: RelayAddressSchema,
  toToken: RelayAddressSchema,
  fromAddress: RelayAddressSchema,
  toAddress: RelayAddressSchema,
  inputAmount: POSITIVE_AMOUNT,
  minimumAmount: POSITIVE_AMOUNT,
});

export interface RelayBridgeConfig {
  apiUrl?: string;
  apiKey?: string;
  chainMetadata?: ChainMap<ChainMetadata>;
  defaultSlippage?: number;
  /** Total nominal token loss, including slippage; intended for equivalent assets. */
  maxQuoteLossBps?: number;
}

/** Direct Relay EVM ERC20 inventory transfers using explicit deposit transactions. */
export class RelayBridge implements IExternalBridge {
  readonly externalBridgeId = ExternalBridgeType.Relay;
  private readonly maxQuoteLossBps: number;
  private readonly defaultSlippage: number;
  private executionLock: Promise<unknown> = Promise.resolve();

  constructor(
    config: RelayBridgeConfig,
    readonly logger: Logger,
    private readonly client = new RelayClient(config),
    private readonly multiProvider = new MultiProvider(
      config.chainMetadata ?? {},
    ),
  ) {
    this.maxQuoteLossBps = config.maxQuoteLossBps ?? 100;
    this.defaultSlippage = config.defaultSlippage ?? 0.001;
    minimumOutputForLoss(1n, 0, 0, this.maxQuoteLossBps);
    this.slippageBps(this.defaultSlippage);
  }

  getNativeTokenAddress(): string {
    return constants.AddressZero;
  }

  async quote(
    params: BridgeQuoteParams,
  ): Promise<BridgeQuote<RelayBridgeRoute>> {
    this.validateParams(params);
    const preparedAt = Date.now();
    const amount = params.fromAmount ?? params.toAmount;
    assert(amount !== undefined, 'Relay quote needs an amount');
    const response = await this.client.quote({
      user: params.fromAddress.toLowerCase(),
      recipient: (params.toAddress ?? params.fromAddress).toLowerCase(),
      originChainId: params.fromChain,
      destinationChainId: params.toChain,
      originCurrency: params.fromToken.toLowerCase(),
      destinationCurrency: params.toToken.toLowerCase(),
      amount: amount.toString(),
      tradeType:
        params.fromAmount !== undefined
          ? RelayTradeType.ExactInput
          : RelayTradeType.ExactOutput,
      slippageTolerance: this.slippageBps(
        params.slippage ?? this.defaultSlippage,
      ).toString(),
    });
    await this.validateResponse(params, response);
    const { currencyIn, currencyOut } = response.details;
    return {
      id: response.requestId,
      tool: this.externalBridgeId,
      fromAmount: BigInt(currencyIn.amount),
      toAmount: BigInt(currencyOut.amount),
      toAmountMin: BigInt(currencyOut.minimumAmount),
      executionDuration: response.details.timeEstimate,
      // Relay deducts execution and liquidity fees from output; native source gas is separate.
      gasCosts: 0n,
      feeCosts: 0n,
      route: { response, preparedAt },
      requestParams: params,
    };
  }

  /** Refresh unsigned calldata without weakening the caller's accepted input/output bounds. */
  async prepare(accepted: BridgeQuote): Promise<BridgeQuote<RelayBridgeRoute>> {
    const refreshed = await this.quote(accepted.requestParams);
    assert(
      refreshed.fromAmount <= accepted.fromAmount,
      'Relay refreshed input exceeds accepted input',
    );
    assert(
      refreshed.toAmountMin >= accepted.toAmountMin,
      'Relay refreshed minimum below accepted minimum',
    );
    return refreshed;
  }

  execute(
    quote: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
    options: BridgeExecutionOptions = {},
  ): Promise<BridgeTransferResult> {
    const execution = this.executionLock.then(() =>
      new TransactionSubmission(options).run((observers) =>
        this.executeUnlocked(quote, privateKeys, { ...options, ...observers }),
      ),
    );
    // Queue failures are reported to their caller, but must not poison subsequent work.
    this.executionLock = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  private async executeUnlocked(
    accepted: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
    options: BridgeExecutionOptions,
  ): Promise<BridgeTransferResult> {
    this.validateParams(accepted.requestParams);
    const original = RelayBridgeRouteSchema.parse(accepted.route);
    assert(
      accepted.id === original.response.requestId,
      'Relay quote identity mismatch',
    );
    assert(
      accepted.fromAmount ===
        BigInt(original.response.details.currencyIn.amount),
      'Relay accepted input mismatch',
    );
    assert(
      accepted.toAmountMin >=
        BigInt(original.response.details.currencyOut.minimumAmount),
      'Relay accepted minimum was weakened',
    );
    const key = privateKeys[ProtocolType.Ethereum];
    assert(key, 'Relay requires an EVM inventory key');
    const wallet = new Wallet(
      key,
      this.multiProvider.getProvider(accepted.requestParams.fromChain),
    );
    assert(
      this.sameAddress(wallet.address, accepted.requestParams.fromAddress),
      'Relay signer does not match quote sender',
    );

    let fresh = await this.prepare(accepted);
    const firstDeposit = this.deposit(fresh.route.response);
    const spender = this.approvalSpender(fresh.route.response);
    await approveErc20IfNeeded(
      wallet,
      accepted.requestParams.fromToken,
      spender,
      fresh.fromAmount,
      this.logger,
      options,
    );
    // Approvals may take time. Always refresh after their receipt and recheck every bound.
    fresh = await this.prepare(accepted);
    const deposit = this.deposit(fresh.route.response);
    assert(
      this.sameAddress(this.approvalSpender(fresh.route.response), spender),
      'Relay approval target changed during preparation',
    );
    assert(
      this.sameAddress(firstDeposit.to, deposit.to),
      'Relay deposit target changed during preparation',
    );
    // A lower exact-output input needs a correspondingly lower allowance too.
    await approveErc20IfNeeded(
      wallet,
      accepted.requestParams.fromToken,
      spender,
      fresh.fromAmount,
      this.logger,
      options,
    );
    assert(
      Date.now() - fresh.route.preparedAt < MAX_PREPARATION_AGE_MS,
      'Relay payload expired during approval',
    );
    const transaction = {
      to: deposit.to,
      data: deposit.data,
      value: BigNumber.from(0),
      chainId: deposit.chainId,
    };
    await wallet.estimateGas(transaction);
    assert(
      Date.now() - fresh.route.preparedAt < MAX_PREPARATION_AGE_MS,
      'Relay payload expired during estimation',
    );
    const transferId = JSON.stringify(
      TransferIdentitySchema.parse({
        version: 1,
        requestId: fresh.id,
        fromChain: accepted.requestParams.fromChain,
        toChain: accepted.requestParams.toChain,
        fromToken: accepted.requestParams.fromToken,
        toToken: accepted.requestParams.toToken,
        fromAddress: accepted.requestParams.fromAddress,
        toAddress:
          accepted.requestParams.toAddress ??
          accepted.requestParams.fromAddress,
        inputAmount: fresh.fromAmount.toString(),
        minimumAmount: accepted.toAmountMin.toString(),
      }),
    );
    await options.onTransferId?.(transferId);
    const submitted = await submitEvmLikeTransaction(
      wallet,
      transaction,
      options,
    );
    return {
      txHash: submitted.hash,
      fromChain: accepted.requestParams.fromChain,
      toChain: accepted.requestParams.toChain,
      transferId,
    };
  }

  async getStatus(
    txHash: string,
    fromChain: number,
    toChain: number,
    transferId?: string,
  ): Promise<BridgeTransferStatus> {
    if (!transferId)
      return {
        status: 'pending',
        substatus:
          'Relay transfer identity missing; manual reconciliation required',
      };
    const identity = TransferIdentitySchema.parse(JSON.parse(transferId));
    RelayHashSchema.parse(txHash);
    assert(
      identity.fromChain === fromChain && identity.toChain === toChain,
      'Relay status chain identity mismatch',
    );
    this.validateChain(fromChain);
    this.validateChain(toChain);
    let status;
    try {
      status = await this.client.getStatus(identity.requestId);
    } catch (error) {
      if (error instanceof RelayRequestError && error.status === 404)
        return { status: 'not_found' };
      throw error;
    }
    if (
      status.status !== RelayStatus.Success &&
      status.status !== RelayStatus.Refund
    ) {
      return {
        status: 'pending',
        substatus: status.refundFailReason
          ? `Relay manual refund required: ${status.refundFailReason}`
          : `Relay ${status.status}${status.failReason ? `: ${status.failReason}` : ''}`,
      };
    }
    assert(
      status.originChainId === fromChain &&
        status.destinationChainId === toChain,
      'Relay status returned different chains',
    );
    assert(
      status.inTxHashes?.some(
        (hash) => hash.toLowerCase() === txHash.toLowerCase(),
      ),
      'Relay status does not identify the source transaction',
    );
    const hashes = status.txHashes;
    if (!hashes?.length)
      return {
        status: 'pending',
        substatus: 'Relay settlement transaction not indexed',
      };
    const sourceProvider = this.multiProvider.getProvider(fromChain);
    const sourceReceipt = await sourceProvider.getTransactionReceipt(txHash);
    if (
      !sourceReceipt ||
      sourceReceipt.status !== 1 ||
      !(await this.finalized(fromChain, sourceReceipt))
    ) {
      return {
        status: 'pending',
        substatus: 'Relay source receipt not finalized',
      };
    }
    const sourceTransaction = await sourceProvider.getTransaction(txHash);
    assert(
      sourceTransaction &&
        this.sameAddress(sourceTransaction.from, identity.fromAddress),
      'Relay source sender mismatch',
    );
    assert(
      sourceTransaction.value.isZero(),
      'Relay source native value was not zero',
    );
    assert(
      -this.credit(sourceReceipt, identity.fromToken, identity.fromAddress) ===
        BigInt(identity.inputAmount),
      'Relay source token debit mismatch',
    );
    const settlementChain =
      status.status === RelayStatus.Refund ? fromChain : toChain;
    const token =
      status.status === RelayStatus.Refund
        ? identity.fromToken
        : identity.toToken;
    const recipient =
      status.status === RelayStatus.Refund
        ? identity.fromAddress
        : identity.toAddress;
    const provider = this.multiProvider.getProvider(settlementChain);
    let amount = 0n;
    for (const hash of new Set(hashes.map((hash) => hash.toLowerCase()))) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (
        !receipt ||
        receipt.status !== 1 ||
        !(await this.finalized(settlementChain, receipt))
      ) {
        return {
          status: 'pending',
          substatus: 'Relay settlement receipt not finalized',
        };
      }
      amount += this.credit(receipt, token, recipient);
    }
    if (status.status === RelayStatus.Refund) {
      assert(amount > 0n, 'Relay refund has no verified source token credit');
      return {
        status: 'failed',
        error: `Relay refunded ${amount} source token units`,
      };
    }
    assert(
      amount >= BigInt(identity.minimumAmount),
      'Relay delivered less than the accepted minimum',
    );
    return {
      status: 'complete',
      receivingTxHash: hashes[0],
      receivedAmount: amount,
    };
  }

  private async validateResponse(
    params: BridgeQuoteParams,
    response: RelayQuoteResponse,
  ): Promise<void> {
    const { currencyIn, currencyOut, sender, recipient } = response.details;
    assert(
      this.sameAddress(sender, params.fromAddress) &&
        this.sameAddress(recipient, params.toAddress ?? params.fromAddress),
      'Relay quote sender or recipient mismatch',
    );
    assert(
      currencyIn.currency.chainId === params.fromChain &&
        currencyOut.currency.chainId === params.toChain,
      'Relay quote chain mismatch',
    );
    assert(
      this.sameAddress(currencyIn.currency.address, params.fromToken) &&
        this.sameAddress(currencyOut.currency.address, params.toToken),
      'Relay quote token mismatch',
    );
    const input = BigInt(currencyIn.amount);
    const output = BigInt(currencyOut.amount);
    const minimum = BigInt(currencyOut.minimumAmount);
    assert(
      input > 0n && minimum > 0n && minimum <= output,
      'Invalid Relay quote amounts',
    );
    if (params.fromAmount !== undefined)
      assert(input === params.fromAmount, 'Relay exact input changed');
    if (params.toAmount !== undefined)
      assert(
        minimum >= params.toAmount,
        'Relay exact output minimum below target',
      );
    const [sourceDecimals, destinationDecimals] = await Promise.all([
      this.decimals(params.fromChain, params.fromToken),
      this.decimals(params.toChain, params.toToken),
    ]);
    assert(
      sourceDecimals === currencyIn.currency.decimals &&
        destinationDecimals === currencyOut.currency.decimals,
      'Relay token decimals mismatch',
    );
    assert(
      minimum >=
        minimumOutputForLoss(
          input,
          sourceDecimals,
          destinationDecimals,
          this.maxQuoteLossBps,
        ),
      'Relay quote minimum exceeds total loss budget',
    );
    const deposit = this.deposit(response);
    for (const step of response.steps) {
      assert(
        step.requestId === response.requestId && !step.depositAddress,
        'Relay request identity or deposit-address flow mismatch',
      );
      const tx = step.items[0].data;
      assert(
        tx.chainId === params.fromChain &&
          this.sameAddress(tx.from, params.fromAddress) &&
          BigInt(tx.value) === 0n,
        'Invalid Relay source transaction',
      );
      assert(
        !this.sameAddress(tx.to, constants.AddressZero),
        'Relay transaction target is zero',
      );
    }
    const approval = response.steps.find(
      (step) => step.id === RelayStepId.Approve,
    );
    if (approval) {
      assert(
        this.sameAddress(approval.items[0].data.to, params.fromToken),
        'Relay approval token mismatch',
      );
      const decoded = ERC20_INTERFACE.decodeFunctionData(
        'approve',
        approval.items[0].data.data,
      );
      const spender = RelayAddressSchema.parse(decoded[0]);
      assert(
        !this.sameAddress(spender, constants.AddressZero),
        'Relay approval spender is zero',
      );
      assert(
        BigNumber.isBigNumber(decoded[1]) && decoded[1].toBigInt() === input,
        'Relay approval amount mismatch',
      );
    }
    // Calldata semantics remain inside the explicitly accepted provider trust boundary.
    assert(deposit.data.length >= 10, 'Relay deposit calldata is empty');
  }

  private deposit(response: RelayQuoteResponse) {
    const deposits = response.steps.filter(
      (step) => step.id === RelayStepId.Deposit,
    );
    const approvals = response.steps.filter(
      (step) => step.id === RelayStepId.Approve,
    );
    assert(
      deposits.length === 1 &&
        approvals.length <= 1 &&
        response.steps.at(-1)?.id === RelayStepId.Deposit,
      'Relay requires at most one approval and exactly one final deposit',
    );
    return deposits[0].items[0].data;
  }

  private approvalSpender(response: RelayQuoteResponse): string {
    const approval = response.steps.find(
      (step) => step.id === RelayStepId.Approve,
    );
    return approval
      ? RelayAddressSchema.parse(
          ERC20_INTERFACE.decodeFunctionData(
            'approve',
            approval.items[0].data.data,
          )[0],
        )
      : this.deposit(response).to;
  }

  private validateParams(params: BridgeQuoteParams): void {
    this.validateChain(params.fromChain);
    this.validateChain(params.toChain);
    assert(
      params.fromChain !== params.toChain,
      'Relay inventory movement requires different chains',
    );
    for (const address of [
      params.fromToken,
      params.toToken,
      params.fromAddress,
      params.toAddress ?? params.fromAddress,
    ]) {
      RelayAddressSchema.parse(address);
      assert(
        !this.sameAddress(address, constants.AddressZero),
        'Relay supports ERC20 tokens and nonzero accounts only',
      );
    }
    assert(
      (params.fromAmount === undefined) !== (params.toAmount === undefined),
      'Relay requires exactly one input or output amount',
    );
    assert(
      (params.fromAmount ?? params.toAmount ?? 0n) > 0n,
      'Relay amount must be positive',
    );
  }

  private validateChain(chainId: number): void {
    const metadata = this.multiProvider.getChainMetadata(chainId);
    assert(
      metadata.protocol === ProtocolType.Ethereum &&
        metadata.availability?.status !== ChainStatus.Disabled,
      'Relay requires an enabled EVM chain',
    );
  }

  private async decimals(chainId: number, token: string): Promise<number> {
    const value: unknown = await new Contract(
      token,
      ERC20_ABI,
      this.multiProvider.getProvider(chainId),
    ).decimals();
    return z.number().int().min(0).max(255).parse(value);
  }

  private slippageBps(slippage: number): number {
    const rawBps = slippage * 10_000;
    const bps = Math.round(rawBps);
    assert(
      Number.isFinite(rawBps) &&
        Math.abs(rawBps - bps) < 1e-8 &&
        bps >= 0 &&
        bps <= 1_000,
      'Relay slippage must be whole basis points between 0 and 1000',
    );
    return bps;
  }

  private sameAddress(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
  }

  private finalized(
    chainId: number,
    receipt: providers.TransactionReceipt,
  ): Promise<boolean> {
    return isReceiptFinalized(
      this.multiProvider.getProvider(chainId),
      receipt,
      this.multiProvider.getChainMetadata(chainId).blocks,
      ProtocolType.Ethereum,
    );
  }

  private credit(
    receipt: providers.TransactionReceipt,
    token: string,
    recipient: string,
  ): bigint {
    let credit = 0n;
    for (const log of receipt.logs) {
      if (
        !this.sameAddress(log.address, token) ||
        log.topics[0] !== TRANSFER_TOPIC
      )
        continue;
      const decoded = ERC20_INTERFACE.parseLog(log).args;
      const from = RelayAddressSchema.parse(decoded[0]);
      const to = RelayAddressSchema.parse(decoded[1]);
      assert(
        BigNumber.isBigNumber(decoded[2]),
        'Invalid ERC20 transfer amount',
      );
      const amount = decoded[2].toBigInt();
      if (this.sameAddress(to, recipient)) credit += amount;
      if (this.sameAddress(from, recipient)) credit -= amount;
    }
    return credit;
  }
}
