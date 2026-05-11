import { utils as ethersUtils } from 'ethers';

import type { IRegistry } from '@hyperlane-xyz/registry';
import {
  getSignerForChain,
  IMultiProtocolSigner,
  MultiProtocolProvider,
  PROTOCOL_TO_DEFAULT_PROVIDER_TYPE,
  ProtocolTypedTransaction,
  Token,
  WarpCore,
  type ChainMetadata,
  type ChainName,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  applyRpcUrlOverridesFromEnv,
  bytesToProtocolAddress,
  objMap,
  objMerge,
  sleep,
  tryFn,
} from '@hyperlane-xyz/utils';

import type { WarpMonitorConfig, WarpNativeDustConfig } from './types.js';
import { getLogger } from './utils.js';

type SentTransferRemoteEvent = {
  blockNumber?: number;
  transactionHash?: string;
  args?: {
    destination?: number;
    recipient?: string;
  };
};

type EventSourceCursor = Map<string, number>;

export class WarpTransferDuster {
  private readonly config: WarpMonitorConfig;
  private readonly registry: IRegistry;

  constructor(config: WarpMonitorConfig, registry: IRegistry) {
    this.config = config;
    this.registry = registry;
  }

  async start(): Promise<void> {
    const logger = this.getLogger();
    const { nativeDusting, warpRouteId, checkFrequency } = this.config;
    if (!nativeDusting) {
      logger.info('Warp transfer duster disabled');
      return;
    }

    const chainMetadata = await this.registry.getMetadata();
    const chainAddresses = await this.registry.getAddresses();
    const overriddenChains = applyRpcUrlOverridesFromEnv(chainMetadata);
    if (overriddenChains.length > 0) {
      logger.info(
        { chains: overriddenChains, count: overriddenChains.length },
        'Applied RPC overrides from environment variables for transfer duster',
      );
    }

    const mailboxes = objMap(chainAddresses, (_, { mailbox }) => ({
      mailbox,
    }));
    const multiProtocolProvider = new MultiProtocolProvider(
      objMerge(chainMetadata, mailboxes),
    );

    const warpCoreConfig = await this.registry.getWarpRoute(warpRouteId);
    if (!warpCoreConfig) {
      throw new Error(
        `Warp route config for ${warpRouteId} not found in registry`,
      );
    }

    const warpCore = WarpCore.FromConfig(multiProtocolProvider, warpCoreConfig);
    const sourceCursors = await this.initializeSourceCursors(
      warpCore,
      nativeDusting,
    );

    logger.info(
      {
        warpRouteId,
        checkFrequency,
        sourceChainCount: [...sourceCursors.keys()].length,
        destinationChains: nativeDusting.destinationChains,
      },
      'Starting warp transfer duster',
    );

    while (true) {
      await tryFn(
        async () =>
          this.processDustingCycle(
            warpCore,
            multiProtocolProvider,
            chainMetadata,
            sourceCursors,
          ),
        'Processing warp transfer dusting cycle',
        logger,
      );
      await sleep(checkFrequency);
    }
  }

  private async initializeSourceCursors(
    warpCore: WarpCore,
    nativeDusting: WarpNativeDustConfig,
  ): Promise<EventSourceCursor> {
    const cursors: EventSourceCursor = new Map();
    const lookback = nativeDusting.eventLookbackBlocks ?? 64;

    for (const token of this.getDustableSourceTokens(warpCore, nativeDusting)) {
      const eventContract = this.getEventContract(token, warpCore.multiProvider);
      if (!eventContract?.provider?.getBlockNumber) continue;
      const currentBlock = await eventContract.provider.getBlockNumber();
      cursors.set(
        this.getCursorKey(token.chainName, token.addressOrDenom),
        Math.max(0, currentBlock - lookback),
      );
    }

    return cursors;
  }

  private async processDustingCycle(
    warpCore: WarpCore,
    multiProtocolProvider: MultiProtocolProvider,
    chainMetadata: Record<string, ChainMetadata>,
    sourceCursors: EventSourceCursor,
  ): Promise<void> {
    const nativeDusting = this.config.nativeDusting;
    if (!nativeDusting) return;

    for (const token of this.getDustableSourceTokens(warpCore, nativeDusting)) {
      const eventContract = this.getEventContract(token, warpCore.multiProvider);
      if (!eventContract?.provider?.getBlockNumber) continue;

      const cursorKey = this.getCursorKey(token.chainName, token.addressOrDenom);
      const fromBlock = sourceCursors.get(cursorKey);
      if (fromBlock === undefined) continue;

      const latestBlock = await eventContract.provider.getBlockNumber();
      if (latestBlock <= fromBlock) continue;

      // CAST: the SentTransferRemote filter narrows the generic ethers event payloads
      // to events that expose destination and recipient args.
      const events = (await eventContract.queryFilter(
        eventContract.filters.SentTransferRemote(),
        fromBlock + 1,
        latestBlock,
      )) as SentTransferRemoteEvent[];

      for (const event of events) {
        if (event.args?.destination == null || !event.args.recipient) {
          this.getLogger().warn(
            {
              blockNumber: event.blockNumber,
              transactionHash: event.transactionHash,
            },
            'Skipping malformed SentTransferRemote event',
          );
          continue;
        }
        await this.handleSentTransferRemoteEvent(
          event,
          chainMetadata,
          multiProtocolProvider,
        );
      }

      sourceCursors.set(cursorKey, latestBlock);
    }
  }

  private async handleSentTransferRemoteEvent(
    event: SentTransferRemoteEvent,
    chainMetadata: Record<string, ChainMetadata>,
    multiProtocolProvider: MultiProtocolProvider,
  ): Promise<void> {
    const logger = this.getLogger();
    const nativeDusting = this.config.nativeDusting;
    if (!nativeDusting) return;

    const destinationDomain = event.args?.destination;
    const recipientBytes32 = event.args?.recipient;
    if (destinationDomain == null || !recipientBytes32) return;

    const destinationChain = this.findChainNameByDomainId(
      chainMetadata,
      destinationDomain,
    );
    if (!destinationChain) {
      logger.warn({ destinationDomain }, 'Skipping dusting for unknown domain');
      return;
    }

    if (
      nativeDusting.destinationChains?.length &&
      !nativeDusting.destinationChains.includes(destinationChain)
    ) {
      return;
    }

    const destinationMetadata = chainMetadata[destinationChain];
    if (!this.isSupportedDustDestinationProtocol(destinationMetadata.protocol)) {
      logger.debug(
        {
          destinationChain,
          protocol: destinationMetadata.protocol,
        },
        'Skipping unsupported dust destination protocol',
      );
      return;
    }

    const recipient = bytesToProtocolAddress(
      Uint8Array.from(Buffer.from(recipientBytes32.slice(2), 'hex')),
      destinationMetadata.protocol,
      destinationMetadata.bech32Prefix,
    );

    await this.ensureRecipientDusted(
      destinationChain,
      recipient,
      multiProtocolProvider,
    );
  }

  private async ensureRecipientDusted(
    destinationChain: ChainName,
    recipient: string,
    multiProtocolProvider: MultiProtocolProvider,
  ): Promise<void> {
    const logger = this.getLogger();
    const nativeDusting = this.config.nativeDusting;
    if (!nativeDusting) return;

    const destinationMetadata =
      multiProtocolProvider.getChainMetadata(destinationChain);
    const threshold = this.parseNativeAmount(
      destinationMetadata,
      nativeDusting.maxRecipientBalance ?? '0',
    );
    const currentBalance = await this.getRecipientNativeBalance(
      destinationChain,
      recipient,
      multiProtocolProvider,
    );

    if (currentBalance > threshold) {
      logger.debug(
        {
          destinationChain,
          recipient,
          currentBalance: currentBalance.toString(),
          threshold: threshold.toString(),
        },
        'Recipient already has sufficient native balance, skipping dust',
      );
      return;
    }

    const amount = this.getDustAmountBaseUnits(destinationChain, destinationMetadata);
    if (amount <= 0n) {
      logger.warn({ destinationChain }, 'Skipping dust transfer with zero amount');
      return;
    }

    const txHash = await this.sendDustTransfer(
      destinationChain,
      recipient,
      amount,
      multiProtocolProvider,
    );
    logger.info(
      {
        destinationChain,
        recipient,
        txHash,
        amount: amount.toString(),
      },
      'Sent native dust transfer to warp recipient',
    );
  }

  private async getRecipientNativeBalance(
    chain: ChainName,
    recipient: string,
    multiProtocolProvider: MultiProtocolProvider,
  ): Promise<bigint> {
    return Token.FromChainMetadataNativeToken(
      multiProtocolProvider.getChainMetadata(chain),
    )
      .getAdapter(multiProtocolProvider)
      .getBalance(recipient);
  }

  private async sendDustTransfer(
    chain: ChainName,
    recipient: string,
    amount: bigint,
    multiProtocolProvider: MultiProtocolProvider,
  ): Promise<string> {
    const destinationMetadata = multiProtocolProvider.getChainMetadata(chain);
    const signerProtocol = this.getSupportedSignerProtocol(
      destinationMetadata.protocol,
    );
    if (!signerProtocol) {
      throw new Error(
        `Unsupported protocol ${destinationMetadata.protocol} for dusting on ${chain}`,
      );
    }

    const signer = await this.getSigner(chain, signerProtocol, multiProtocolProvider);
    const fromAddress = await signer.address();
    const nativeToken = Token.FromChainMetadataNativeToken(destinationMetadata);
    const funderBalance = await nativeToken
      .getAdapter(multiProtocolProvider)
      .getBalance(fromAddress);

    if (funderBalance < amount) {
      throw new Error(
        `Insufficient native dusting balance on ${chain}: has ${funderBalance}, needs ${amount}`,
      );
    }

    const transaction = await nativeToken.getAdapter(multiProtocolProvider).populateTransferTx({
      weiAmountOrId: amount,
      recipient,
      fromAccountOwner: fromAddress,
    });
    const type = PROTOCOL_TO_DEFAULT_PROVIDER_TYPE[signerProtocol];

    // CAST: the signer protocol and transaction type are derived from the same chain metadata,
    // so the populated native transfer transaction matches the signer implementation for that chain.
    return signer.sendAndConfirmTransaction({
      transaction,
      type,
    } as ProtocolTypedTransaction<ProtocolType>);
  }

  private async getSigner(
    chain: ChainName,
    protocol: ProtocolType.Ethereum | ProtocolType.Tron | ProtocolType.CosmosNative,
    multiProtocolProvider: MultiProtocolProvider,
  ): Promise<IMultiProtocolSigner<ProtocolType>> {
    const nativeDusting = this.config.nativeDusting;
    if (!nativeDusting) throw new Error('Native dusting config is required');

    return getSignerForChain(
      chain,
      {
        protocol,
        privateKey: nativeDusting.privateKey,
      },
      multiProtocolProvider,
    );
  }

  private getDustAmountBaseUnits(
    chain: ChainName,
    chainMetadata: ChainMetadata,
  ): bigint {
    const nativeDusting = this.config.nativeDusting;
    if (!nativeDusting) throw new Error('Native dusting config is required');

    const amount =
      nativeDusting.amountByChain?.[chain] ?? nativeDusting.defaultAmount;
    return this.parseNativeAmount(chainMetadata, amount);
  }

  private parseNativeAmount(
    chainMetadata: ChainMetadata,
    amount: string,
  ): bigint {
    const nativeToken = Token.FromChainMetadataNativeToken(chainMetadata);
    return BigInt(
      ethersUtils.parseUnits(amount, nativeToken.decimals).toString(),
    );
  }

  private getDustableSourceTokens(
    warpCore: WarpCore,
    nativeDusting: WarpNativeDustConfig,
  ) {
    return warpCore.tokens.filter(
      (token: WarpCore['tokens'][number]) =>
        token.protocol === ProtocolType.Ethereum &&
        (!nativeDusting.sourceChains?.length ||
          nativeDusting.sourceChains.includes(token.chainName)),
    );
  }

  private getEventContract(
    token: WarpCore['tokens'][number],
    multiProtocolProvider: MultiProtocolProvider,
  ) {
    // CAST: the SDK's adapter interface does not expose the underlying event-emitting
    // contract handles, but Hyperlane token adapters provide either contract or
    // collateralContract with SentTransferRemote on EVM routes.
    const hypAdapter = token.getHypAdapter(multiProtocolProvider) as {
      contract?: {
        provider?: { getBlockNumber: () => Promise<number> };
        filters: { SentTransferRemote: () => unknown };
        queryFilter: (
          filter: unknown,
          fromBlock: number,
          toBlock: number,
        ) => Promise<SentTransferRemoteEvent[]>;
      };
      collateralContract?: {
        provider?: { getBlockNumber: () => Promise<number> };
        filters: { SentTransferRemote: () => unknown };
        queryFilter: (
          filter: unknown,
          fromBlock: number,
          toBlock: number,
        ) => Promise<SentTransferRemoteEvent[]>;
      };
    };

    return hypAdapter.contract ?? hypAdapter.collateralContract;
  }

  private findChainNameByDomainId(
    chainMetadata: Record<string, ChainMetadata>,
    domainId: number,
  ): ChainName | undefined {
    return Object.entries(chainMetadata).find(
      ([, metadata]) => metadata.domainId === domainId,
    )?.[0] as ChainName | undefined; // CAST: chainMetadata keys are ChainNames by construction.
  }

  private isSupportedDustDestinationProtocol(protocol: ProtocolType): boolean {
    return !!this.getSupportedSignerProtocol(protocol);
  }

  private getSupportedSignerProtocol(
    protocol: ProtocolType,
  ): ProtocolType.Ethereum | ProtocolType.Tron | ProtocolType.CosmosNative | undefined {
    switch (protocol) {
      case ProtocolType.Ethereum:
      case ProtocolType.Tron:
      case ProtocolType.CosmosNative:
        return protocol;
      case ProtocolType.Cosmos:
        return ProtocolType.CosmosNative;
      default:
        return undefined;
    }
  }

  private getLogger() {
    return getLogger().child({
      warp_route: this.config.warpRouteId,
      dusting: 'native-recipient',
    });
  }

  private getCursorKey(chain: string, routerAddress: string): string {
    return `${chain}:${routerAddress.toLowerCase()}`;
  }
}
