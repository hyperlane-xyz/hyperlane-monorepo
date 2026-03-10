import { toUtf8Bytes } from 'ethers';

import {
  ChainMap,
  ChainName,
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
  ) {
    const sender = this.getContracts(from).router;
    const toDomain = this.multiProvider.getDomainId(to);
    const { blocks, transactionOverrides } =
      this.multiProvider.getChainMetadata(from);

    // apply gas buffer due to https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/634
    const estimated = await sender.sendHelloWorld.estimateGas(
      toDomain,
      message,
      { ...transactionOverrides, value },
    );

    const quote = await sender.quoteDispatch(toDomain, toUtf8Bytes(message));
    const tx = await sender.sendHelloWorld(toDomain, message, {
      gasLimit: addBufferToGasLimit(estimated),
      ...transactionOverrides,
      value: value + quote,
    });
    this.logger.info('Sending hello message', {
      from,
      to,
      message,
      tx,
    });
    const receipt = await tx.wait(blocks?.confirmations ?? 1);
    if (!receipt) throw new Error('Transaction receipt was null');
    return receipt;
  }

  async waitForMessageReceipt(
    receipt: Parameters<HyperlaneCore['waitForMessageProcessing']>[0],
  ) {
    return this.core.waitForMessageProcessing(receipt);
  }

  async waitForMessageProcessed(
    receipt: Parameters<HyperlaneCore['waitForMessageProcessed']>[0],
  ) {
    return this.core.waitForMessageProcessed(receipt);
  }

  async channelStats(from: ChainName, to: ChainName): Promise<StatCounts> {
    const sent = await this.getContracts(from).router.sentTo(
      this.multiProvider.getDomainId(to),
    );
    const received = await this.getContracts(to).router.receivedFrom(
      this.multiProvider.getDomainId(from),
    );

    return { sent: Number(sent), received: Number(received) };
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
