import { BigNumber, ethers } from 'ethers';

import {
  AbacusApp,
  AbacusCore,
  ChainMap,
  ChainName,
  ChainNameToDomainId,
  MultiProvider,
  Remotes,
} from '@abacus-network/sdk';

import { HelloWorldContracts } from './contracts';

type Counts = {
  sent: number;
  received: number;
};

export class HelloWorldApp<
  Chain extends ChainName = ChainName,
> extends AbacusApp<HelloWorldContracts, Chain> {
  constructor(
    public readonly core: AbacusCore<Chain>,
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
    afterSend?: (receipt: ethers.ContractReceipt) => void,
  ): Promise<ethers.ContractReceipt[]> {
    const sender = this.getContracts(from).router;
    const toDomain = ChainNameToDomainId[to];
    const chainConnection = this.multiProvider.getChainConnection(from);

    // apply gas buffer due to https://github.com/abacus-network/abacus-monorepo/issues/634
    const estimated = await sender.estimateGas.sendHelloWorld(
      toDomain,
      message,
      chainConnection.overrides,
    );
    const gasLimit = estimated.mul(11).div(10);

    const tx = await sender.sendHelloWorld(toDomain, message, {
      ...chainConnection.overrides,
      gasLimit,
      value,
    });
    const receipt = await tx.wait(chainConnection.confirmations);

    // just sent, but have not yet waited for it to complete
    if (afterSend) afterSend(receipt);

    // wait for it to complete
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

  async stats(): Promise<Record<string, Record<string, Counts>>> {
    const entries: Array<[string, Record<string, Counts>]> = await Promise.all(
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
    return Object.fromEntries(entries);
  }
}
