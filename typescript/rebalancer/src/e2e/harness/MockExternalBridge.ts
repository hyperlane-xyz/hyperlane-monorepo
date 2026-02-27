import { pad } from 'viem';
import { pino, type Logger } from 'pino';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
  HypNative__factory,
} from '@hyperlane-xyz/core';
import { HyperlaneRelayer } from '@hyperlane-xyz/relayer';
import {
  HyperlaneCore,
  LocalAccountViemSigner,
  type MultiProvider,
} from '@hyperlane-xyz/sdk';
import { ensure0x } from '@hyperlane-xyz/utils';

import type {
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../../interfaces/IExternalBridge.js';
import type {
  Erc20InventoryDeployedAddresses,
  NativeDeployedAddresses,
  TestChain,
} from '../fixtures/routes.js';

type MockBridgeRoute = {
  fromChain: number;
  toChain: number;
  fromAddress: string;
  toAddress: string;
  tokenType: 'native' | 'erc20';
};

type EvmProvider = ReturnType<MultiProvider['getProvider']>;

export class MockExternalBridge implements IExternalBridge {
  readonly externalBridgeId = 'mock-bridge';
  readonly logger: Logger;

  private readonly failStatusOverrides = new Map<
    string,
    BridgeTransferStatus
  >();
  private _failNextExecute = false;

  constructor(
    private readonly deployedAddresses:
      | NativeDeployedAddresses
      | Erc20InventoryDeployedAddresses,
    private readonly multiProvider: MultiProvider,
    private readonly core: HyperlaneCore,
    private readonly tokenType: 'native' | 'erc20' = 'native',
    logger?: Logger,
  ) {
    this.logger =
      logger ??
      pino({ level: 'silent' }).child({
        module: 'MockExternalBridge',
      });
  }

  getNativeTokenAddress(): string {
    return '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
  }

  async quote(params: BridgeQuoteParams): Promise<BridgeQuote> {
    if (params.fromAmount !== undefined && params.toAmount !== undefined) {
      throw new Error(
        'Cannot specify both fromAmount and toAmount - provide exactly one',
      );
    }
    if (params.fromAmount === undefined && params.toAmount === undefined) {
      throw new Error('Must specify either fromAmount or toAmount');
    }

    const amount = params.fromAmount ?? params.toAmount!;
    const toAddress = params.toAddress ?? params.fromAddress;

    const gasCosts = await this.estimateGasCosts(
      params.fromChain,
      params.toChain,
      toAddress,
      params.fromAddress,
    );

    const route: MockBridgeRoute = {
      fromChain: params.fromChain,
      toChain: params.toChain,
      fromAddress: params.fromAddress,
      toAddress,
      tokenType: this.tokenType,
    };

    return {
      id: `mock-quote-${Date.now()}`,
      tool: this.externalBridgeId,
      fromAmount: amount,
      toAmount: amount,
      toAmountMin: amount,
      executionDuration: 1,
      gasCosts,
      feeCosts: 0n,
      route,
    };
  }

  async execute(
    quote: BridgeQuote,
    privateKey: string,
  ): Promise<BridgeTransferResult> {
    if (this._failNextExecute) {
      this._failNextExecute = false;
      throw new Error('MockExternalBridge execute failure injected');
    }

    const route = this.parseRoute(quote.route);
    const fromChain = route.fromChain;
    const toChain = route.toChain;

    const fromChainName = this.resolveChainName(fromChain);
    const toChainName = this.resolveChainName(toChain);

    const bridgeRouteAddress =
      this.deployedAddresses.bridgeRoute[fromChainName];
    const destinationDomain = this.multiProvider.getDomainId(toChainName);

    const provider = this.multiProvider.getProvider(fromChainName);
    const signer = new LocalAccountViemSigner(ensure0x(privateKey)).connect(
      provider,
    );

    const recipientBytes32 = pad(route.toAddress as `0x${string}`, {
      size: 32,
    });

    let tx;
    if (route.tokenType === 'erc20') {
      if (!('tokens' in this.deployedAddresses)) {
        throw new Error('Expected ERC20 deployed addresses');
      }

      const tokenAddress = this.deployedAddresses.tokens[fromChainName];
      const token = ERC20Test__factory.connect(tokenAddress, signer);
      await token.approve(bridgeRouteAddress, quote.fromAmount);

      const bridgeRoute = HypERC20Collateral__factory.connect(
        bridgeRouteAddress,
        signer,
      );
      tx = await bridgeRoute.transferRemote(
        destinationDomain,
        recipientBytes32,
        quote.fromAmount,
      );
    } else {
      const bridgeRoute = HypNative__factory.connect(
        bridgeRouteAddress,
        signer,
      );
      tx = await bridgeRoute.transferRemote(
        destinationDomain,
        recipientBytes32,
        quote.fromAmount,
        { value: quote.fromAmount },
      );
    }

    return {
      txHash: tx.hash,
      fromChain,
      toChain,
    };
  }

  async getStatus(
    txHash: string,
    fromChain: number,
    toChain: number,
  ): Promise<BridgeTransferStatus> {
    const override = this.failStatusOverrides.get(txHash);
    if (override) {
      return override;
    }

    try {
      const fromChainName = this.resolveChainName(fromChain);
      const toChainName = this.resolveChainName(toChain);
      const provider = this.multiProvider.getProvider(fromChainName);
      const dispatchTxReceipt = await provider.getTransactionReceipt(txHash);

      if (!dispatchTxReceipt) {
        return { status: 'not_found' };
      }

      const relayer = new HyperlaneRelayer({ core: this.core });
      const receipts = await relayer.relayAll(dispatchTxReceipt);

      const destinationDomain = this.multiProvider.getDomainId(toChainName);
      const destinationReceipts =
        receipts[toChainName] ??
        receipts[toChain] ??
        receipts[destinationDomain];

      if (!destinationReceipts || destinationReceipts.length === 0) {
        return { status: 'not_found' };
      }

      const receivedAmount = await this.getTransferredAmount(
        provider,
        dispatchTxReceipt,
      );

      return {
        status: 'complete',
        receivingTxHash: destinationReceipts[0].transactionHash,
        receivedAmount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'failed', error: message };
    }
  }

  failStatusFor(
    txHash: string,
    status: BridgeTransferStatus = { status: 'failed' },
  ): void {
    this.failStatusOverrides.set(txHash, status);
  }

  failNextExecute(): void {
    this._failNextExecute = true;
  }

  reset(): void {
    this.failStatusOverrides.clear();
    this._failNextExecute = false;
  }

  /**
   * Estimates gas costs for a transferRemote call on the bridge route.
   * Uses a small amount (1 wei) to avoid balance-related estimation failures.
   */
  private async estimateGasCosts(
    fromChain: number,
    toChain: number,
    toAddress: string,
    fromAddress: string,
  ): Promise<bigint> {
    const fromChainName = this.resolveChainName(fromChain);
    const toChainName = this.resolveChainName(toChain);

    const bridgeRouteAddress =
      this.deployedAddresses.bridgeRoute[fromChainName];
    const destinationDomain = this.multiProvider.getDomainId(toChainName);
    const provider = this.multiProvider.getProvider(fromChainName);

    const recipientBytes32 = pad(toAddress as `0x${string}`, { size: 32 });

    // Use 1 wei for estimation — gas usage doesn't depend on transfer amount
    const estimateAmount = 1n;
    if (this.tokenType === 'erc20') {
      // ERC20 path requires setup/allowance; mock out gas for test invariants.
      return 0n;
    }

    const bridgeRoute = HypNative__factory.connect(
      bridgeRouteAddress,
      provider,
    );
    const gasEstimate = await bridgeRoute.estimateGas.transferRemote(
      destinationDomain,
      recipientBytes32,
      estimateAmount,
      { value: estimateAmount, from: fromAddress },
    );

    const gasPrice = await provider.getGasPrice();
    return toBigIntLike(gasEstimate) * toBigIntLike(gasPrice);
  }

  private parseRoute(route: unknown): MockBridgeRoute {
    if (!route || typeof route !== 'object') {
      throw new Error('Mock quote route is missing');
    }

    const parsed = route as Partial<MockBridgeRoute>;

    if (
      typeof parsed.fromChain !== 'number' ||
      typeof parsed.toChain !== 'number' ||
      typeof parsed.fromAddress !== 'string' ||
      typeof parsed.toAddress !== 'string'
    ) {
      throw new Error('Mock quote route is invalid');
    }

    return {
      fromChain: parsed.fromChain,
      toChain: parsed.toChain,
      fromAddress: parsed.fromAddress,
      toAddress: parsed.toAddress,
      tokenType:
        parsed.tokenType === 'erc20' || parsed.tokenType === 'native'
          ? parsed.tokenType
          : 'native',
    };
  }

  private resolveChainName(chainRef: number): TestChain {
    const chainNames = Object.keys(
      this.deployedAddresses.chains,
    ) as TestChain[];

    for (const chainName of chainNames) {
      const chainId = Number(this.multiProvider.getChainId(chainName));
      const domainId = this.multiProvider.getDomainId(chainName);
      if (chainId === chainRef || domainId === chainRef) {
        return chainName;
      }
    }

    throw new Error(`Chain not found for id/domain ${chainRef}`);
  }

  private async getTransferredAmount(
    provider: EvmProvider,
    receipt: { transactionHash: string },
  ): Promise<bigint> {
    const tx = await provider.getTransaction(receipt.transactionHash);
    if (!tx) {
      throw new Error(
        `Transaction ${receipt.transactionHash} not found on provider`,
      );
    }

    try {
      const txData = getTxData(tx);
      if (!txData) {
        throw new Error(
          `Missing transaction calldata for ${receipt.transactionHash}`,
        );
      }
      const parsed = HypNative__factory.createInterface().parseTransaction({
        data: txData,
        value: getTxValue(tx),
      });

      if (!parsed || parsed.name !== 'transferRemote') {
        throw new Error(
          `Expected transferRemote tx, got: ${parsed?.name ?? 'unparseable'}`,
        );
      }

      const amount = parsed.args[2];
      return toBigIntLike(amount);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { txHash: receipt.transactionHash, error: message },
        'Failed to parse transferRemote amount from tx',
      );
      throw new Error(`Failed to parse transferred amount: ${message}`);
    }
  }
}

function toBigIntLike(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  if (
    typeof value === 'object' &&
    value !== null &&
    'toBigInt' in value &&
    typeof (value as { toBigInt?: unknown }).toBigInt === 'function'
  ) {
    return (value as { toBigInt: () => bigint }).toBigInt();
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'toString' in value &&
    typeof (value as { toString?: unknown }).toString === 'function'
  ) {
    return BigInt((value as { toString: () => string }).toString());
  }
  throw new Error(`Unable to convert value to bigint: ${String(value)}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function getTxData(tx: unknown): string | undefined {
  const record = asRecord(tx);
  if (!record) return undefined;

  const data = record.data;
  if (typeof data === 'string' && data.startsWith('0x')) return data;

  const input = record.input;
  if (typeof input === 'string' && input.startsWith('0x')) return input;

  const nestedTx = record.transaction;
  if (nestedTx !== undefined) return getTxData(nestedTx);

  return undefined;
}

function getTxValue(tx: unknown): unknown {
  const record = asRecord(tx);
  if (!record) return undefined;

  if ('value' in record) return record.value;

  const nestedTx = record.transaction;
  if (nestedTx !== undefined) return getTxValue(nestedTx);

  return undefined;
}
