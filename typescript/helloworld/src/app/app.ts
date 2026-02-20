import {
  ChainMap,
  ChainName,
  type HyperlaneCore as HyperlaneCoreType,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneCore,
  MultiProvider,
  RouterApp,
} from '@hyperlane-xyz/sdk';
import { Address, addBufferToGasLimit, rootLogger } from '@hyperlane-xyz/utils';

import { HelloWorld } from '../types/index.js';

import { HelloWorldFactories } from './contracts.js';
import { StatCounts } from './types.js';

type SourceReceipt = Parameters<
  HyperlaneCoreType['waitForMessageProcessed']
>[0];

export class HelloWorldApp extends RouterApp<HelloWorldFactories> {
  constructor(
    public readonly core: HyperlaneCore,
    contractsMap: HyperlaneContractsMap<HelloWorldFactories>,
    multiProvider: MultiProvider,
    foreignDeployments: ChainMap<Address> = {},
  ) {
    super(
      contractsMap,
      multiProvider,
      rootLogger.child({ module: 'HelloWorldApp' }),
      foreignDeployments,
    );
  }

  router(contracts: HyperlaneContracts<HelloWorldFactories>): HelloWorld {
    return contracts.router;
  }

  async sendHelloWorld(
    from: ChainName,
    to: ChainName,
    message: string,
    value: bigint,
  ): Promise<SourceReceipt> {
    const sender = this.getContracts(from).router;
    const toDomain = this.multiProvider.getDomainId(to);
    const { blocks, transactionOverrides } =
      this.multiProvider.getChainMetadata(from);

    // apply gas buffer due to https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/634
    const estimated = await sender.estimateGas.sendHelloWorld(
      toDomain,
      message,
      { ...transactionOverrides, value },
    );

    const quote = await sender.quoteDispatch(toDomain, message);
    const totalValue = quote.add(value.toString());
    const tx = await sender.sendHelloWorld(toDomain, message, {
      gasLimit: addBufferToGasLimit(estimated),
      ...transactionOverrides,
      value: totalValue,
    });
    this.logger.info('Sending hello message', {
      from,
      to,
      message,
      tx,
    });
    return tx.wait(blocks?.confirmations ?? 1);
  }

  async waitForMessageReceipt(
    receipt: SourceReceipt,
  ): Promise<SourceReceipt[]> {
    return this.core.waitForMessageProcessing(receipt);
  }

  async waitForMessageProcessed(
    receipt: SourceReceipt,
  ): Promise<void> {
    return this.core.waitForMessageProcessed(receipt);
  }

  async channelStats(from: ChainName, to: ChainName): Promise<StatCounts> {
    const sent = await this.getContracts(from).router.sentTo(
      this.multiProvider.getDomainId(to),
    );
    const received = await this.getContracts(to).router.receivedFrom(
      this.multiProvider.getDomainId(from),
    );

    return { sent: sent.toNumber(), received: received.toNumber() };
  }

  async stats(): Promise<ChainMap<ChainMap<StatCounts>>> {
    const entries: Array<[ChainName, ChainMap<StatCounts>]> = await Promise.all(
      this.chains().map(async (source) => {
        const remoteChains = await this.remoteChains(source);
        const destinationEntries = await Promise.all(
          remoteChains.map(async (destination) => [
            destination,
            await this.channelStats(source, destination),
          ]),
        );
        return [source, Object.fromEntries(destinationEntries)];
      }),
    );
    return Object.fromEntries(entries);
  }
}
