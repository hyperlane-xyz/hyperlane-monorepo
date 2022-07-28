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
    timeoutMs?: number,
  ): Promise<ethers.ContractReceipt> {
    const sender = this.getContracts(from).router;
    const toDomain = ChainNameToDomainId[to];
    const chainConnection = this.multiProvider.getChainConnection(from);

    // apply gas buffer due to https://github.com/abacus-network/abacus-monorepo/issues/634
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
    console.log(tx);

    const promise = tx.wait(chainConnection.confirmations);
    if (timeoutMs && timeoutMs > 0) {
      return new Promise((resolve, reject) => {
        setTimeout(
          () => reject(new Error('Timeout waiting for message to be sent')),
          timeoutMs,
        );
        promise.then(resolve).catch(reject);
      });
    }
    return promise;
  }

  async waitForMessageReceipt(
    receipt: ethers.ContractReceipt,
    timeoutMs?: number,
  ): Promise<ethers.ContractReceipt[]> {
    const promise = this.core.waitForMessageProcessing(receipt);
    if (timeoutMs && timeoutMs > 0) {
      return new Promise((resolve, reject) => {
        setTimeout(
          () => reject(new Error('Timeout waiting for message receipt')),
          timeoutMs,
        );
        promise.then(resolve).catch(reject);
      });
    }
    return promise;
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
