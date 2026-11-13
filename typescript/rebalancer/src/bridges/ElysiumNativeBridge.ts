import {
  Address,
  type ArbitrumNetwork,
  ParentToChildMessageGasEstimator,
  ParentToChildMessageStatus,
  ParentTransactionReceipt,
  getArbitrumNetworkInformationFromRollup,
  getArbitrumNetworks,
  registerCustomArbitrumNetwork,
} from '@arbitrum/sdk';
import { L1ERC20Gateway__factory } from '@arbitrum/sdk/dist/lib/abi/factories/L1ERC20Gateway__factory.js';
import { L1GatewayRouter__factory } from '@arbitrum/sdk/dist/lib/abi/factories/L1GatewayRouter__factory.js';
import { IArbToken__factory } from '@arbitrum/sdk/dist/lib/abi/factories/IArbToken__factory.js';
import { ethers } from 'ethers';
import type { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';

import { ERC20__factory } from '@hyperlane-xyz/core';
import {
  type ChainMap,
  type ChainMetadata,
  ChainStatus,
  MultiProvider,
  submitEvmLikeTransaction,
} from '@hyperlane-xyz/sdk';
import {
  LazyAsync,
  ProtocolType,
  TransactionSubmission,
  assert,
  eqAddress,
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

import { isReceiptFinalized } from '../utils/receiptFinality.js';
import { waitForReceiptWithTimeout } from '../utils/receiptTimeout.js';

import { approveErc20IfNeeded } from './erc20Approve.js';

/** Mainnet canonical contracts, published in Elysium's token-bridging docs. */
export const ELYSIUM_NATIVE_BRIDGE = {
  parentChainId: 999,
  childChainId: 99901,
  parentToken: '0xb88339cb7199b77e23db6e890353e22632ba630f',
  childToken: '0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65',
  rollup: '0x508c173dfe5f737b3493195bf785d71fa76fd217',
  parentRouter: '0x5d24f760dd7664b4214bdd4b04a3f62b9edd68c0',
  parentGateway: '0xd97b30de0ba0c2eaee942afce77530e06c5f122c',
  childGateway: '0x5dc84e4cb0f9082246e92a5585c5395592b1af1f',
};

const DEFAULT_MAX_NATIVE_VALUE_WEI = 10_000_000_000_000_000n;
const EXPECTED_USDC_DECIMALS = 6;
const ESTIMATED_DEPOSIT_SECONDS = 60;
const TRANSFER_TOPIC =
  ERC20__factory.createInterface().getEventTopic('Transfer');
const ALIASED_PARENT_GATEWAY = new Address(
  ELYSIUM_NATIVE_BRIDGE.parentGateway,
).applyAlias().value;

export interface ElysiumNativeBridgeConfig {
  chainMetadata: ChainMap<ChainMetadata>;
  /** HYPE attached for retryable delivery, excluding parent transaction gas. */
  maxNativeValueWei?: bigint;
}

interface NativeDeposit {
  request: ethers.providers.TransactionRequest;
  nativeValue: bigint;
}

/** Inbound canonical USDC deposits only; no canonical withdrawals or swaps. */
export class ElysiumNativeBridge implements IExternalBridge {
  readonly externalBridgeId = ExternalBridgeType.ElysiumNative;
  readonly logger: Logger;
  private readonly multiProvider: MultiProvider;
  private readonly maxNativeValueWei: bigint;
  private readonly network: LazyAsync<ArbitrumNetwork>;
  private executionLock: Promise<void> = Promise.resolve();

  constructor(config: ElysiumNativeBridgeConfig, logger: Logger) {
    this.logger = logger;
    this.maxNativeValueWei =
      config.maxNativeValueWei ?? DEFAULT_MAX_NATIVE_VALUE_WEI;
    assert(
      this.maxNativeValueWei > 0n,
      'Native delivery budget must be positive',
    );
    const metadata: ChainMap<ChainMetadata> = {};
    for (const chainId of [
      ELYSIUM_NATIVE_BRIDGE.parentChainId,
      ELYSIUM_NATIVE_BRIDGE.childChainId,
    ]) {
      const matches = Object.values(config.chainMetadata).filter(
        (chain) =>
          chain.chainId === chainId &&
          chain.protocol === ProtocolType.Ethereum &&
          chain.availability?.status !== ChainStatus.Disabled,
      );
      const chain = matches[0];
      assert(
        chain && matches.length === 1,
        `Missing or duplicate chain ${chainId}`,
      );
      assert(chain.rpcUrls.length > 0, `Missing RPC for chain ${chainId}`);
      metadata[chain.name] = chain;
    }
    this.multiProvider = new MultiProvider(metadata, { logger });
    this.network = new LazyAsync(() => this.initializeNetwork());
  }

  getNativeTokenAddress(): string {
    return ethers.constants.AddressZero;
  }

  async quote(params: BridgeQuoteParams): Promise<BridgeQuote<NativeDeposit>> {
    const amount = this.validateParams(params);
    const route = await this.prepareDeposit(params, amount);
    return {
      id: uuidv4(),
      tool: this.externalBridgeId,
      fromAmount: amount,
      toAmount: amount,
      toAmountMin: amount,
      executionDuration: ESTIMATED_DEPOSIT_SECONDS,
      // HYPE prepaid for child delivery. Parent gas is estimated on submission,
      // after approval; a full parent eth_estimateGas requires an allowance.
      gasCosts: route.nativeValue,
      feeCosts: 0n,
      route,
      requestParams: { ...params },
    };
  }

  execute(
    quote: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
    options: BridgeExecutionOptions = {},
  ): Promise<BridgeTransferResult> {
    const execution = this.executionLock.then(() =>
      this.executeDeposit(quote, privateKeys, options),
    );
    this.executionLock = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  private executeDeposit(
    quote: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
    options: BridgeExecutionOptions,
  ): Promise<BridgeTransferResult> {
    return new TransactionSubmission(options).run(async (observers) => {
      const amount = this.validateQuote(quote);
      const key = privateKeys[ProtocolType.Ethereum];
      assert(key, 'Missing Ethereum inventory key');
      const signer = new ethers.Wallet(key, this.parentProvider);
      assert(
        eqAddress(signer.address, quote.requestParams.fromAddress),
        'Native bridge signer does not match quote sender',
      );
      // Check the route and budget before making an approval transaction.
      await this.prepareDeposit(quote.requestParams, amount);
      await approveErc20IfNeeded(
        signer,
        ELYSIUM_NATIVE_BRIDGE.parentToken,
        ELYSIUM_NATIVE_BRIDGE.parentGateway,
        amount,
        this.logger,
        { onApproval: options.onApproval },
      );
      // Gas prices and gateway configuration may change during approval.
      const deposit = await this.prepareDeposit(quote.requestParams, amount);
      const tx = await submitEvmLikeTransaction(
        signer,
        deposit.request,
        observers,
      );
      // Keep approvals serialized until the prior deposit consumed its allowance.
      await waitForReceiptWithTimeout(tx, {
        txHash: tx.hash,
        operation: 'Elysium canonical deposit',
      });
      return {
        txHash: tx.hash,
        fromChain: ELYSIUM_NATIVE_BRIDGE.parentChainId,
        toChain: ELYSIUM_NATIVE_BRIDGE.childChainId,
      };
    });
  }

  async getStatus(
    txHash: string,
    fromChain: number,
    toChain: number,
  ): Promise<BridgeTransferStatus> {
    this.validateDirection(fromChain, toChain);
    assert(
      ethers.utils.isHexString(txHash, 32),
      'Invalid deposit transaction hash',
    );
    const network = await this.network.get();
    const receipt = await this.parentProvider.getTransactionReceipt(txHash);
    if (!receipt) return { status: 'pending', substatus: 'SOURCE_NOT_MINED' };
    if (!(await this.isConfirmed(receipt, fromChain)))
      return { status: 'pending', substatus: 'SOURCE_NOT_FINAL' };
    if (receipt.status === 0)
      return {
        status: 'failed',
        error: 'Canonical deposit transaction reverted',
      };
    assert(
      receipt.status === 1,
      'Canonical deposit receipt has no success status',
    );
    assert(
      eqAddress(receipt.to, ELYSIUM_NATIVE_BRIDGE.parentRouter),
      'Transaction was not sent to the canonical router',
    );
    // Only parse logs from the configured canonical contracts. Source receipts
    // contain all data needed to recover a retryable without process state.
    const parentReceipt = new ParentTransactionReceipt({
      ...receipt,
      logs: receipt.logs.filter((log) =>
        [
          ELYSIUM_NATIVE_BRIDGE.parentGateway,
          network.ethBridge.bridge,
          network.ethBridge.inbox,
        ].some((address) => eqAddress(log.address, address)),
      ),
    });
    const deposits = parentReceipt.getTokenDepositEvents();
    const deposit = deposits[0];
    assert(
      deposit && deposits.length === 1,
      'Expected one canonical token deposit',
    );
    assert(
      eqAddress(deposit.l1Token, ELYSIUM_NATIVE_BRIDGE.parentToken) &&
        eqAddress(deposit._from, receipt.from) &&
        deposit._amount.gt(0),
      'Unexpected canonical USDC deposit',
    );
    const amount = deposit._amount.toBigInt();
    assert(
      this.transferredAmount(
        receipt,
        ELYSIUM_NATIVE_BRIDGE.parentToken,
        deposit._from,
        ELYSIUM_NATIVE_BRIDGE.parentGateway,
      ) === amount,
      'Canonical deposit does not match the source USDC debit',
    );
    const messages = await parentReceipt.getParentToChildMessages(
      this.childProvider,
    );
    const message = messages[0];
    assert(
      message && messages.length === 1,
      'Expected one canonical retryable',
    );
    assert(
      // Contract senders are aliased by the canonical Inbox on the child chain.
      eqAddress(message.sender, ALIASED_PARENT_GATEWAY) &&
        eqAddress(
          message.messageData.destAddress,
          ELYSIUM_NATIVE_BRIDGE.childGateway,
        ),
      'Unexpected retryable gateway',
    );
    const result = await message.getSuccessfulRedeem();
    switch (result.status) {
      case ParentToChildMessageStatus.NOT_YET_CREATED:
        return { status: 'pending', substatus: 'RETRYABLE_NOT_CREATED' };
      case ParentToChildMessageStatus.FUNDS_DEPOSITED_ON_CHILD:
        this.logger.error(
          {
            txHash,
            retryableId: message.retryableCreationId,
            substatus: 'MANUAL_REDEMPTION_REQUIRED',
          },
          'Canonical USDC deposit requires manual redemption before retryable expiry',
        );
        return { status: 'pending', substatus: 'MANUAL_REDEMPTION_REQUIRED' };
      case ParentToChildMessageStatus.CREATION_FAILED:
      case ParentToChildMessageStatus.EXPIRED:
        return {
          status: 'failed',
          error: `Canonical retryable ${ParentToChildMessageStatus[result.status]}: ${message.retryableCreationId}`,
        };
      case ParentToChildMessageStatus.REDEEMED: {
        const childReceipt = result.childTxReceipt;
        assert(
          childReceipt.status === 1,
          'Retryable redemption did not succeed',
        );
        if (!(await this.isConfirmed(childReceipt, toChain)))
          return { status: 'pending', substatus: 'DESTINATION_NOT_FINAL' };
        const receivedAmount = this.transferredAmount(
          childReceipt,
          ELYSIUM_NATIVE_BRIDGE.childToken,
          ethers.constants.AddressZero,
          deposit._to,
        );
        assert(
          receivedAmount === amount,
          'Canonical USDC mint does not match deposit',
        );
        return {
          status: 'complete',
          receivingTxHash: childReceipt.transactionHash,
          receivedAmount,
        };
      }
    }
  }

  private get parentProvider(): ethers.providers.Provider {
    return this.multiProvider.getProvider(ELYSIUM_NATIVE_BRIDGE.parentChainId);
  }

  private get childProvider(): ethers.providers.Provider {
    return this.multiProvider.getProvider(ELYSIUM_NATIVE_BRIDGE.childChainId);
  }

  private validateDirection(fromChain: number, toChain: number): void {
    assert(
      fromChain === ELYSIUM_NATIVE_BRIDGE.parentChainId &&
        toChain === ELYSIUM_NATIVE_BRIDGE.childChainId,
      'Elysium native bridge only supports HyperEVM to Elysium deposits',
    );
  }

  private validateParams(params: BridgeQuoteParams): bigint {
    this.validateDirection(params.fromChain, params.toChain);
    assert(
      eqAddress(params.fromToken, ELYSIUM_NATIVE_BRIDGE.parentToken) &&
        eqAddress(params.toToken, ELYSIUM_NATIVE_BRIDGE.childToken),
      'Elysium native bridge only supports canonical USDC',
    );
    assert(
      ethers.utils.isAddress(params.fromAddress) &&
        ethers.utils.isAddress(params.toAddress ?? params.fromAddress),
      'Invalid native bridge sender or recipient',
    );
    assert(
      !eqAddress(
        params.toAddress ?? params.fromAddress,
        ethers.constants.AddressZero,
      ),
      'Native bridge recipient must not be zero',
    );
    assert(
      (params.fromAmount === undefined) !== (params.toAmount === undefined),
      'Provide exactly one of fromAmount or toAmount',
    );
    const amount = params.fromAmount ?? params.toAmount;
    assert(
      amount !== undefined && amount > 0n,
      'Native deposit amount must be positive',
    );
    return amount;
  }

  private validateQuote(quote: BridgeQuote): bigint {
    const amount = this.validateParams(quote.requestParams);
    assert(
      quote.tool === this.externalBridgeId,
      'Quote was not created by native bridge',
    );
    assert(
      quote.fromAmount === amount &&
        quote.toAmount === amount &&
        quote.toAmountMin === amount,
      'Native USDC quote amounts must remain one-to-one',
    );
    return amount;
  }

  private async initializeNetwork(): Promise<ArbitrumNetwork> {
    const info = await getArbitrumNetworkInformationFromRollup(
      ELYSIUM_NATIVE_BRIDGE.rollup,
      this.parentProvider,
    );
    const child = await this.childProvider.getNetwork();
    this.validateDirection(info.parentChainId, child.chainId);
    assert(
      info.nativeToken === undefined ||
        eqAddress(info.nativeToken, ethers.constants.AddressZero),
      'Elysium must use native HYPE, not an ERC20 gas token',
    );
    const network: ArbitrumNetwork = {
      ...info,
      chainId: ELYSIUM_NATIVE_BRIDGE.childChainId,
      name: 'elysium',
      isTestnet: false,
      isCustom: true,
    };
    const existing = getArbitrumNetworks().find(
      (entry) => entry.chainId === network.chainId,
    );
    if (existing) {
      assert(
        existing.parentChainId === network.parentChainId &&
          eqAddress(existing.ethBridge.rollup, network.ethBridge.rollup) &&
          eqAddress(existing.ethBridge.inbox, network.ethBridge.inbox) &&
          eqAddress(existing.ethBridge.bridge, network.ethBridge.bridge) &&
          (existing.nativeToken === undefined ||
            eqAddress(existing.nativeToken, ethers.constants.AddressZero)),
        'Conflicting Elysium Arbitrum SDK registration',
      );
      return existing;
    }
    return registerCustomArbitrumNetwork(network);
  }

  private async prepareDeposit(
    params: BridgeQuoteParams,
    amount: bigint,
  ): Promise<NativeDeposit> {
    const network = await this.network.get();
    const router = L1GatewayRouter__factory.connect(
      ELYSIUM_NATIVE_BRIDGE.parentRouter,
      this.parentProvider,
    );
    const gateway = L1ERC20Gateway__factory.connect(
      ELYSIUM_NATIVE_BRIDGE.parentGateway,
      this.parentProvider,
    );
    const childToken = IArbToken__factory.connect(
      ELYSIUM_NATIVE_BRIDGE.childToken,
      this.childProvider,
    );
    const [
      mappedGateway,
      mappedToken,
      counterpart,
      inbox,
      parentToken,
      parentDecimals,
      childDecimals,
    ] = await Promise.all([
      router.getGateway(ELYSIUM_NATIVE_BRIDGE.parentToken),
      router.calculateL2TokenAddress(ELYSIUM_NATIVE_BRIDGE.parentToken),
      gateway.counterpartGateway(),
      gateway.inbox(),
      childToken.l1Address(),
      ERC20__factory.connect(
        ELYSIUM_NATIVE_BRIDGE.parentToken,
        this.parentProvider,
      ).decimals(),
      ERC20__factory.connect(
        ELYSIUM_NATIVE_BRIDGE.childToken,
        this.childProvider,
      ).decimals(),
    ]);
    assert(
      eqAddress(mappedGateway, gateway.address) &&
        eqAddress(mappedToken, childToken.address) &&
        eqAddress(counterpart, ELYSIUM_NATIVE_BRIDGE.childGateway) &&
        eqAddress(inbox, network.ethBridge.inbox) &&
        eqAddress(parentToken, ELYSIUM_NATIVE_BRIDGE.parentToken) &&
        parentDecimals === EXPECTED_USDC_DECIMALS &&
        childDecimals === EXPECTED_USDC_DECIMALS,
      'Canonical USDC bridge mapping changed',
    );
    const recipient = params.toAddress ?? params.fromAddress;
    const data = await gateway.getOutboundCalldata(
      ELYSIUM_NATIVE_BRIDGE.parentToken,
      params.fromAddress,
      recipient,
      amount,
      '0x',
    );
    const parentBlock = await this.parentProvider.getBlock('latest');
    assert(parentBlock?.baseFeePerGas, 'Missing HyperEVM base fee');
    const estimates = await new ParentToChildMessageGasEstimator(
      this.childProvider,
    ).estimateAll(
      {
        from: gateway.address,
        to: counterpart,
        l2CallValue: ethers.constants.Zero,
        excessFeeRefundAddress: params.fromAddress,
        callValueRefundAddress: params.fromAddress,
        data,
      },
      parentBlock.baseFeePerGas,
      this.parentProvider,
    );
    const nativeValue = estimates.deposit.toBigInt();
    assert(
      nativeValue > 0n && nativeValue <= this.maxNativeValueWei,
      'Canonical delivery exceeds native HYPE budget',
    );
    const request =
      await router.populateTransaction.outboundTransferCustomRefund(
        ELYSIUM_NATIVE_BRIDGE.parentToken,
        params.fromAddress,
        recipient,
        amount,
        estimates.gasLimit,
        estimates.maxFeePerGas,
        ethers.utils.defaultAbiCoder.encode(
          ['uint256', 'bytes'],
          [estimates.maxSubmissionCost, '0x'],
        ),
        { from: params.fromAddress, value: estimates.deposit },
      );
    return { request, nativeValue };
  }

  private isConfirmed(
    receipt: ethers.providers.TransactionReceipt,
    chainId: number,
  ): Promise<boolean> {
    return isReceiptFinalized(
      this.multiProvider.getProvider(chainId),
      receipt,
      this.multiProvider.getChainMetadata(chainId).blocks,
      ProtocolType.Ethereum,
    );
  }

  private transferredAmount(
    receipt: ethers.providers.TransactionReceipt,
    token: string,
    from: string,
    to: string,
  ): bigint {
    let total = 0n;
    const fromTopic = ethers.utils.hexZeroPad(from, 32).toLowerCase();
    const toTopic = ethers.utils.hexZeroPad(to, 32).toLowerCase();
    for (const log of receipt.logs) {
      if (
        !eqAddress(log.address, token) ||
        log.topics.length !== 3 ||
        log.topics[0] !== TRANSFER_TOPIC ||
        log.topics[1].toLowerCase() !== fromTopic ||
        log.topics[2].toLowerCase() !== toTopic
      )
        continue;
      assert(
        ethers.utils.isHexString(log.data, 32),
        'Malformed USDC transfer log',
      );
      total += BigInt(log.data);
    }
    return total;
  }
}
