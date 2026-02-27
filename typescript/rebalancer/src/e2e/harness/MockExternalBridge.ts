import {
  Provider,
  TransactionReceipt,
  JsonRpcProvider,
  Wallet,
  hexlify,
  parseEther,
  toBeHex,
  zeroPadValue,
} from 'ethers';
import { pino, type Logger } from 'pino';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
  HypNative__factory,
} from '@hyperlane-xyz/core';
import { HyperlaneRelayer } from '@hyperlane-xyz/relayer';
import { HyperlaneCore, type MultiProvider } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import type {
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../../interfaces/IExternalBridge.js';
import {
  ANVIL_TEST_PRIVATE_KEY,
  Erc20InventoryDeployedAddresses,
  type NativeDeployedAddresses,
  type TestChain,
} from '../fixtures/routes.js';

type MockBridgeRoute = {
  fromChain: number;
  toChain: number;
  fromAddress: string;
  toAddress: string;
  tokenType: 'native' | 'erc20';
};

export class MockExternalBridge implements IExternalBridge {
  readonly externalBridgeId = 'mock-bridge';
  readonly logger: Logger;

  private readonly failStatusOverrides = new Map<
    string,
    BridgeTransferStatus
  >();
  private _failNextExecute = false;
  private readonly deployedAddresses:
    | NativeDeployedAddresses
    | Erc20InventoryDeployedAddresses;
  private readonly tokenType: 'native' | 'erc20';

  constructor(
    deployedAddresses:
      | NativeDeployedAddresses
      | Erc20InventoryDeployedAddresses,
    private readonly multiProvider: MultiProvider,
    private readonly core: HyperlaneCore,
    tokenType: 'native' | 'erc20' = 'native',
    logger?: Logger,
  ) {
    this.deployedAddresses = deployedAddresses;
    this.tokenType = tokenType;
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
    const signer = new Wallet(privateKey, provider);

    const recipientBytes32 = zeroPadValue(hexlify(route.toAddress), 32);

    let tx;
    if (this.tokenType === 'erc20') {
      assert(
        'tokens' in this.deployedAddresses,
        'Expected ERC20 deployed addresses',
      );
      const tokenAddress = (
        this.deployedAddresses as Erc20InventoryDeployedAddresses
      ).tokens[fromChainName];
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

      const relayChains = this.core.chains();
      const coreAddresses = Object.fromEntries(
        relayChains.map((chain) => [chain, this.core.getAddresses(chain)]),
      );
      const { result: relayMultiProvider } =
        this.multiProvider.intersect(relayChains);
      for (const chain of relayChains) {
        const relayProvider = relayMultiProvider.getProvider(
          chain,
        ) as JsonRpcProvider;
        const relaySigner = new Wallet(ANVIL_TEST_PRIVATE_KEY, relayProvider);
        await relayProvider.send('anvil_setBalance', [
          relaySigner.address,
          toBeHex(parseEther('100')),
        ]);
        relayMultiProvider.setSigner(chain, relaySigner);
      }

      const relayCore = HyperlaneCore.fromAddressesMap(
        coreAddresses,
        relayMultiProvider,
      );
      const relayer = new HyperlaneRelayer({ core: relayCore });
      const receipts = await relayer.relayAll(dispatchTxReceipt);

      const destinationDomain =
        relayCore.multiProvider.getDomainId(toChainName);
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
      const receivingTxHash =
        (destinationReceipts[0] as { hash?: string; transactionHash?: string })
          .hash ??
        (destinationReceipts[0] as { transactionHash?: string })
          .transactionHash;

      return {
        status: 'complete',
        receivingTxHash,
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

    const recipientBytes32 = zeroPadValue(hexlify(toAddress), 32);

    // Use 1 wei for estimation — gas usage doesn't depend on transfer amount
    const estimateAmount = 1n;
    if (this.tokenType === 'erc20') {
      // ERC20 transferRemote requires token approval which isn't set up during estimation.
      // Return 0n as a mock — gas costs don't affect test logic.
      return 0n;
    }

    const bridgeRoute = HypNative__factory.connect(bridgeRouteAddress, provider);
    const gasEstimate = await bridgeRoute.transferRemote.estimateGas(
      destinationDomain,
      recipientBytes32,
      estimateAmount,
      { value: estimateAmount, from: fromAddress },
    );

    const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
    return gasEstimate * gasPrice;
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
      typeof parsed.toAddress !== 'string' ||
      (parsed.tokenType !== 'native' && parsed.tokenType !== 'erc20')
    ) {
      throw new Error('Mock quote route is invalid');
    }

    return {
      fromChain: parsed.fromChain,
      toChain: parsed.toChain,
      fromAddress: parsed.fromAddress,
      toAddress: parsed.toAddress,
      tokenType: parsed.tokenType,
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
    provider: Provider,
    receipt: TransactionReceipt,
  ): Promise<bigint> {
    const txHash =
      (receipt as { hash?: string; transactionHash?: string }).hash ??
      (receipt as { transactionHash?: string }).transactionHash;
    if (!txHash) {
      throw new Error('Missing transaction hash on receipt');
    }

    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      throw new Error(`Transaction ${txHash} not found on provider`);
    }

    try {
      const parsed = HypNative__factory.createInterface().parseTransaction({
        data: tx.data,
        value: tx.value,
      });

      if (!parsed || parsed.name !== 'transferRemote') {
        throw new Error(
          `Expected transferRemote tx, got: ${parsed?.name ?? 'unparseable'}`,
        );
      }

      const amount = parsed.args[2];
      if (typeof amount === 'bigint') {
        return amount;
      }
      return BigInt(String(amount));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { txHash, error: message },
        'Failed to parse transferRemote amount from tx',
      );
      throw new Error(`Failed to parse transferred amount: ${message}`);
    }
  }
}
