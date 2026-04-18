import { join } from 'path';
import { fileURLToPath } from 'url';

import type { Logger } from 'pino';
import { parse as parseYaml } from 'yaml';

import type { IRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  type ChainName,
  getSignerForChain,
  HyperlaneCore,
  MultiProtocolProvider,
  type MultiProvider,
  type Token,
  type WarpCoreConfig,
  WarpCore,
  type WarpTypedTransaction,
  WarpTxCategory,
} from '@hyperlane-xyz/sdk';
import {
  assert,
  ensure0x,
  parseWarpRouteMessage,
  ProtocolType,
} from '@hyperlane-xyz/utils';
import { readYamlOrJson } from '@hyperlane-xyz/utils/fs';

import type {
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import { toProtocolTransaction } from '../utils/transactionUtils.js';

const FAST_CONFIG_RELATIVE_PATH =
  'deployments/warp_routes/USDC/mainnet-cctp-v2-fast-config.yaml';
const STANDARD_CONFIG_RELATIVE_PATH =
  'deployments/warp_routes/USDC/mainnet-cctp-v2-standard-config.yaml';

export type CctpWarpBridgeMode = 'fast' | 'standard';

export interface CctpWarpBridgeConfig {
  mode: CctpWarpBridgeMode;
}

type CctpWarpBridgeRoute = {
  mode: CctpWarpBridgeMode;
  fromChainName: ChainName;
  toChainName: ChainName;
  fromAddress: string;
  toAddress: string;
};

type CctpWarpBridgeContext = {
  warpCore: WarpCore;
  hyperlaneCore: HyperlaneCore;
};

export class CctpWarpBridge implements IExternalBridge {
  readonly externalBridgeId = 'cctpWarp';
  readonly logger: Logger;

  private contextPromise?: Promise<CctpWarpBridgeContext>;

  constructor(
    private readonly config: CctpWarpBridgeConfig,
    private readonly multiProvider: MultiProvider,
    private readonly registry: IRegistry,
    logger: Logger,
  ) {
    this.logger = logger;
  }

  protected getSelectedRegistryRelativePath(): string {
    return this.config.mode === 'fast'
      ? FAST_CONFIG_RELATIVE_PATH
      : STANDARD_CONFIG_RELATIVE_PATH;
  }

  protected async getContext(): Promise<CctpWarpBridgeContext> {
    if (!this.contextPromise) {
      this.contextPromise = this.buildContext();
    }
    return this.contextPromise;
  }

  private async buildContext(): Promise<CctpWarpBridgeContext> {
    const warpCoreConfig = await this.loadWarpCoreConfig();
    const addresses = await this.registry.getAddresses();

    const warpChains = [
      ...new Set(warpCoreConfig.tokens.map((t) => t.chainName)),
    ];
    for (const chain of warpChains) {
      if (this.multiProvider.getProtocol(chain) === ProtocolType.Ethereum) {
        this.multiProvider.getProvider(chain);
      }
    }

    const mailboxes = Object.fromEntries(
      Object.entries(addresses).map(([chain, chainAddresses]) => [
        chain,
        { mailbox: chainAddresses.mailbox },
      ]),
    ) as ChainMap<{ mailbox?: string }>;

    const multiProtocolProvider = MultiProtocolProvider.fromMultiProvider(
      this.multiProvider,
    );
    const extendedMultiProtocolProvider =
      multiProtocolProvider.extendChainMetadata(mailboxes);

    return {
      warpCore: WarpCore.FromConfig(
        extendedMultiProtocolProvider,
        warpCoreConfig,
      ),
      hyperlaneCore: HyperlaneCore.fromAddressesMap(
        addresses,
        this.multiProvider,
      ),
    };
  }

  protected async loadWarpCoreConfig(): Promise<WarpCoreConfig> {
    const baseUri = this.getRegistryUri();
    const relativePath = this.getSelectedRegistryRelativePath();

    if (!baseUri) {
      throw new Error(
        'Registry URI is unavailable; cannot load CCTP warp config',
      );
    }

    if (this.isRemoteUri(baseUri)) {
      const url = this.toConfigUrl(baseUri, relativePath);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch CCTP warp config from ${url}: ${response.status} ${response.statusText}`,
        );
      }

      return parseYaml(await response.text()) as WarpCoreConfig;
    }

    const localPath = this.toLocalConfigPath(baseUri, relativePath);
    return readYamlOrJson<WarpCoreConfig>(localPath);
  }

  protected getRegistryUri(): string | undefined {
    if (
      'getUri' in this.registry &&
      typeof this.registry.getUri === 'function'
    ) {
      return this.registry.getUri();
    }
    if ('uri' in this.registry && typeof this.registry.uri === 'string') {
      return this.registry.uri;
    }
    return undefined;
  }

  private isRemoteUri(uri: string): boolean {
    return /^https?:\/\//.test(uri);
  }

  private toLocalConfigPath(baseUri: string, relativePath: string): string {
    if (baseUri.startsWith('file://')) {
      return join(fileURLToPath(baseUri), relativePath);
    }
    return join(baseUri, relativePath);
  }

  private toConfigUrl(baseUri: string, relativePath: string): string {
    const url = new URL(baseUri);

    if (url.hostname === 'github.com') {
      const pathParts = url.pathname.split('/').filter(Boolean);
      assert(
        pathParts.length >= 2,
        `Unsupported GitHub registry URI: ${baseUri}`,
      );

      const [owner, repo, maybeTree, ...rest] = pathParts;
      const ref = maybeTree === 'tree' ? rest.join('/') || 'main' : 'main';
      return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${relativePath}`;
    }

    const normalized = baseUri.endsWith('/') ? baseUri : `${baseUri}/`;
    return new URL(relativePath, normalized).toString();
  }

  async quote(
    params: BridgeQuoteParams,
  ): Promise<BridgeQuote<CctpWarpBridgeRoute>> {
    assert(
      params.toAmount === undefined,
      'CCTP warp bridge does not support toAmount quotes',
    );
    assert(
      params.fromAmount !== undefined,
      'CCTP warp bridge requires fromAmount quotes',
    );
    assert(params.fromAmount > 0n, 'fromAmount must be positive');

    const { warpCore } = await this.getContext();
    const route = this.resolveBridgeRoute(warpCore, params);
    const fromToken = this.getWarpTokenForChain(warpCore, route.fromChainName);
    const toToken = this.getWarpTokenForChain(warpCore, route.toChainName);

    const feeEstimate = await warpCore.estimateTransferRemoteFees({
      originTokenAmount: fromToken.amount(params.fromAmount),
      destination: route.toChainName,
      recipient: route.toAddress,
      sender: route.fromAddress,
      destinationToken: toToken,
    });

    const tokenFeeAmount = feeEstimate.tokenFeeQuote?.amount ?? 0n;
    const receivedAmount =
      params.fromAmount > tokenFeeAmount
        ? params.fromAmount - tokenFeeAmount
        : 0n;

    return {
      id: `${this.externalBridgeId}-${this.config.mode}-${Date.now()}`,
      tool: 'hyperlane-cctp-warp',
      fromAmount: params.fromAmount,
      toAmount: receivedAmount,
      toAmountMin: receivedAmount,
      executionDuration: 0,
      gasCosts: feeEstimate.interchainQuote.amount,
      feeCosts: tokenFeeAmount,
      route,
      requestParams: params,
    };
  }

  async execute(
    quote: BridgeQuote<CctpWarpBridgeRoute>,
    privateKeys: Partial<Record<ProtocolType, string>>,
  ): Promise<BridgeTransferResult> {
    const { warpCore } = await this.getContext();
    const route = this.parseRoute(quote.route);
    const fromToken = this.getWarpTokenForChain(warpCore, route.fromChainName);
    const toToken = this.getWarpTokenForChain(warpCore, route.toChainName);
    const sourceProtocol = this.multiProvider.getProtocol(route.fromChainName);
    const privateKey = privateKeys[sourceProtocol];

    assert(
      route.mode === this.config.mode,
      `Quote mode ${route.mode} does not match bridge mode ${this.config.mode}`,
    );
    assert(
      privateKey,
      `Missing private key for protocol ${sourceProtocol} on ${route.fromChainName}`,
    );

    const txs = await warpCore.getTransferRemoteTxs({
      originTokenAmount: fromToken.amount(quote.fromAmount),
      destination: route.toChainName,
      sender: route.fromAddress,
      recipient: route.toAddress,
      destinationToken: toToken,
    });

    assert(txs.length > 0, 'Expected at least one transferRemote transaction');

    let transferTxHash: string | undefined;
    for (const tx of txs) {
      const txHash = await this.sendWarpTransaction(
        route.fromChainName,
        tx,
        privateKey,
        warpCore.multiProvider,
      );
      if (tx.category === WarpTxCategory.Transfer) {
        transferTxHash = txHash;
      }
    }

    assert(transferTxHash, 'No transfer transaction hash found');

    const receipt = await this.multiProvider
      .getProvider(route.fromChainName)
      .getTransactionReceipt(transferTxHash);
    assert(receipt, `Transfer transaction ${transferTxHash} receipt not found`);

    const dispatchedMessages = HyperlaneCore.getDispatchedMessages(receipt);
    assert(
      dispatchedMessages.length === 1,
      `Expected exactly 1 dispatched message, got ${dispatchedMessages.length}`,
    );

    return {
      txHash: transferTxHash,
      fromChain: quote.requestParams.fromChain,
      toChain: quote.requestParams.toChain,
      transferId: dispatchedMessages[0].id,
    };
  }

  async getStatus(
    txHash: string,
    fromChain: number,
    toChain: number,
  ): Promise<BridgeTransferStatus> {
    try {
      const { hyperlaneCore, warpCore } = await this.getContext();
      const fromChainName = this.resolveChainName(warpCore, fromChain);
      const expectedToChainName = this.resolveChainName(warpCore, toChain);
      const receipt = await this.multiProvider
        .getProvider(fromChainName)
        .getTransactionReceipt(txHash);

      if (!receipt) {
        return { status: 'not_found' };
      }

      const dispatchedMessages = HyperlaneCore.getDispatchedMessages(receipt);
      if (dispatchedMessages.length !== 1) {
        return {
          status: 'failed',
          error: `Expected exactly 1 dispatched message, got ${dispatchedMessages.length}`,
        };
      }

      const dispatched = dispatchedMessages[0];
      const actualToChainName = hyperlaneCore.getDestination(dispatched);
      if (actualToChainName !== expectedToChainName) {
        return {
          status: 'failed',
          error: `Dispatched destination ${actualToChainName} does not match expected ${expectedToChainName}`,
        };
      }

      const delivered = await hyperlaneCore.isDelivered(dispatched);
      if (!delivered) {
        return { status: 'pending' };
      }

      const { amount } = parseWarpRouteMessage(dispatched.parsed.body);

      try {
        const processedReceipt =
          await hyperlaneCore.getProcessedReceipt(dispatched);
        return {
          status: 'complete',
          receivingTxHash: processedReceipt.transactionHash,
          receivedAmount: amount,
        };
      } catch (error) {
        this.logger.warn(
          {
            txHash,
            messageId: dispatched.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Delivered CCTP warp message found without process receipt, falling back to origin tx hash',
        );
        return {
          status: 'complete',
          receivingTxHash: txHash,
          receivedAmount: amount,
        };
      }
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  protected async sendWarpTransaction(
    chainName: ChainName,
    tx: WarpTypedTransaction,
    privateKey: string,
    multiProtocolProvider: MultiProtocolProvider<{ mailbox?: string }>,
  ): Promise<string> {
    const signer = await getSignerForChain(
      chainName,
      {
        protocol: ProtocolType.Ethereum,
        privateKey: ensure0x(privateKey),
      },
      multiProtocolProvider,
    );
    const metadata = multiProtocolProvider.getChainMetadata(chainName);
    const configuredConfirmations =
      metadata.blocks?.reorgPeriod ?? metadata.blocks?.confirmations;
    const waitConfirmations =
      typeof configuredConfirmations === 'number' ? configuredConfirmations : 1;

    return signer.sendAndConfirmTransaction(
      toProtocolTransaction(tx, ProtocolType.Ethereum),
      { waitConfirmations },
    );
  }

  private resolveBridgeRoute(
    warpCore: WarpCore,
    params: BridgeQuoteParams,
  ): CctpWarpBridgeRoute {
    const fromChainName = this.resolveChainName(warpCore, params.fromChain);
    const toChainName = this.resolveChainName(warpCore, params.toChain);
    const toAddress = params.toAddress ?? params.fromAddress;
    const fromToken = this.getWarpTokenForChain(warpCore, fromChainName);

    assert(
      fromToken.getConnectionForChain(toChainName),
      `No CCTP warp route connection from ${fromChainName} to ${toChainName}`,
    );

    return {
      mode: this.config.mode,
      fromChainName,
      toChainName,
      fromAddress: params.fromAddress,
      toAddress,
    };
  }

  private resolveChainName(warpCore: WarpCore, chainRef: number): ChainName {
    const chainNames = [...new Set(warpCore.tokens.map((t) => t.chainName))];

    for (const chainName of chainNames) {
      const chainId = Number(this.multiProvider.getChainId(chainName));
      const domainId = this.multiProvider.getDomainId(chainName);
      if (chainId === chainRef || domainId === chainRef) {
        return chainName;
      }
    }

    throw new Error(`Unsupported CCTP warp chain reference ${chainRef}`);
  }

  private getWarpTokenForChain(
    warpCore: WarpCore,
    chainName: ChainName,
  ): Token {
    const token = warpCore.tokens.find((t) => t.chainName === chainName);
    assert(token, `No CCTP warp token configured for chain ${chainName}`);
    return token;
  }

  private parseRoute(route: unknown): CctpWarpBridgeRoute {
    assert(route && typeof route === 'object', 'CCTP warp route is missing');
    const parsed = route as Partial<CctpWarpBridgeRoute>;

    assert(
      parsed.mode === 'fast' || parsed.mode === 'standard',
      'CCTP warp route mode is invalid',
    );
    assert(
      typeof parsed.fromChainName === 'string',
      'CCTP warp route fromChainName is invalid',
    );
    assert(
      typeof parsed.toChainName === 'string',
      'CCTP warp route toChainName is invalid',
    );
    assert(
      typeof parsed.fromAddress === 'string',
      'CCTP warp route fromAddress is invalid',
    );
    assert(
      typeof parsed.toAddress === 'string',
      'CCTP warp route toAddress is invalid',
    );

    return {
      mode: parsed.mode,
      fromChainName: parsed.fromChainName,
      toChainName: parsed.toChainName,
      fromAddress: parsed.fromAddress,
      toAddress: parsed.toAddress,
    };
  }
}
