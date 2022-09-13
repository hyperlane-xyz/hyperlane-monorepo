import { BigNumber, ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  ChainNameToDomainId,
  HyperlaneApp,
  HyperlaneCore,
  MultiProvider,
  Remotes,
} from '@hyperlane-xyz/sdk';
import { debug } from '@hyperlane-xyz/utils';

import { HelloWorldContracts } from './contracts';

type Counts = {
  sent: number;
  received: number;
};

export class HelloWorldApp<
  Chain extends ChainName = ChainName,
> extends HyperlaneApp<HelloWorldContracts, Chain> {
  constructor(
    public readonly core: HyperlaneCore<Chain>,
    contractsMap: ChainMap<Chain, HelloWorldContracts>,
    multiProvider: MultiProvider<Chain>,
  ) {
    super(contractsMap, multiProvider);
  }

  async sendHelloWorld<From extends Chain>(
    from: From,
    to: Remotes<Chain, From>,
    message: string,
    value: BigNumber,
  ): Promise<ethers.ContractReceipt> {
    const sender = this.getContracts(from).router;
    const toDomain = ChainNameToDomainId[to];
    const chainConnection = this.multiProvider.getChainConnection(from);

    // apply gas buffer due to https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/634
    const estimated = await sender.estimateGas.sendHelloWorld(
      toDomain,
      message,
      { ...chainConnection.overrides, value },
    );
    const gasLimit = estimated.mul(12).div(10);

    const tx = await sender.sendHelloWorld(toDomain, message, {
      ...chainConnection.overrides,
      gasLimit,
      value,
    });
    debug('Sending hello message', {
      from,
      to,
      message,
      tx,
    });
    return tx.wait(chainConnection.confirmations);
  }

  async waitForMessageReceipt(
    receipt: ethers.ContractReceipt,
  ): Promise<ethers.ContractReceipt[]> {
    return this.core.waitForMessageProcessing(receipt);
  }

  async channelStats<From extends Chain>(
    from: From,
    to: Remotes<Chain, From>,
  ): Promise<Counts> {
    const sent = await this.getContracts(from).router.sentTo(
      ChainNameToDomainId[to],
    );
    const received = await this.getContracts(to).router.receivedFrom(
      ChainNameToDomainId[from],
    );

    return { sent: sent.toNumber(), received: received.toNumber() };
  }

  async stats(): Promise<Record<Chain, Record<Chain, Counts>>> {
    const entries: Array<[Chain, Record<Chain, Counts>]> = await Promise.all(
      this.chains().map(async (source) => {
        const destinationEntries = await Promise.all(
          this.remoteChains(source).map(async (destination) => [
            destination,
            await this.channelStats(source, destination),
          ]),
        );
        return [
          source,
          Object.fromEntries(destinationEntries) as Record<Chain, Counts>,
        ];
      }),
    );
    return Object.fromEntries(entries) as Record<Chain, Record<Chain, Counts>>;
  }
}
