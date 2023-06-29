import { BigNumber, ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneCore,
  MultiProvider,
  RouterApp,
} from '@hyperlane-xyz/sdk';
import { debug } from '@hyperlane-xyz/utils';

import { HelloWorld } from '../types';

import { HelloWorldFactories } from './contracts';

type Counts = {
  sent: number;
  received: number;
};

export class HelloWorldApp extends RouterApp<HelloWorldFactories> {
  constructor(
    public readonly core: HyperlaneCore,
    contractsMap: HyperlaneContractsMap<HelloWorldFactories>,
    multiProvider: MultiProvider,
  ) {
    super(contractsMap, multiProvider);
  }

  router(contracts: HyperlaneContracts<HelloWorldFactories>): HelloWorld {
    return contracts.router;
  }

  async sendHelloWorld(
    from: ChainName,
    to: ChainName,
    message: string,
    value: BigNumber,
  ): Promise<ethers.ContractReceipt> {
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
    const gasLimit = estimated.mul(12).div(10);

    const tx = await sender.sendHelloWorld(toDomain, message, {
      ...transactionOverrides,
      gasLimit,
      value,
    });
    debug('Sending hello message', {
      from,
      to,
      message,
      tx,
    });
    return tx.wait(blocks?.confirmations || 1);
  }

  async waitForMessageReceipt(
    receipt: ethers.ContractReceipt,
  ): Promise<ethers.ContractReceipt[]> {
    return this.core.waitForMessageProcessing(receipt);
  }

  async waitForMessageProcessed(
    receipt: ethers.ContractReceipt,
  ): Promise<void> {
    return this.core.waitForMessageProcessed(receipt);
  }

  async channelStats(from: ChainName, to: ChainName): Promise<Counts> {
    const sent = await this.getContracts(from).router.sentTo(
      this.multiProvider.getDomainId(to),
    );
    const received = await this.getContracts(to).router.receivedFrom(
      this.multiProvider.getDomainId(from),
    );

    return { sent: sent.toNumber(), received: received.toNumber() };
  }

  async stats(): Promise<ChainMap<ChainMap<Counts>>> {
    const entries: Array<[ChainName, ChainMap<Counts>]> = await Promise.all(
      this.chains().map(async (source) => {
        const destinationEntries = await Promise.all(
          this.remoteChains(source).map(async (destination) => [
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
