import { ethers } from 'ethers';

import {
  AbacusApp,
  AbacusCore,
  ChainName,
  ChainNameToDomainId,
  Remotes,
} from '@abacus-network/sdk';
import { CoreEnvironment } from '@abacus-network/sdk/dist/core/AbacusCore';

import { HelloWorldContracts } from './contracts';

export class HelloWorldApp<
  Chain extends ChainName = ChainName,
> extends AbacusApp<HelloWorldContracts, Chain> {
  async sendHelloWorld<From extends Chain>(
    environment: CoreEnvironment,
    from: From,
    to: Remotes<Chain, From>,
    message: string,
  ): Promise<ethers.ContractReceipt[]> {
    const sender = this.getContracts(from).router;
    const toDomain = ChainNameToDomainId[to];
    const chainConnection = this.multiProvider.getChainConnection(from);
    const core = AbacusCore.fromEnvironment(
      environment,
      this.multiProvider as any,
    );

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
    });
    const receipt = await tx.wait(chainConnection.confirmations);
    return core.waitForMessageProcessing(receipt);
  }

  async channelStats<From extends Chain>(from: From, to: Remotes<Chain, From>) {
    const sent = await this.getContracts(from).router.sentTo(
      ChainNameToDomainId[to],
    );
    const received = await this.getContracts(to).router.receivedFrom(
      ChainNameToDomainId[from],
    );

    return { sent: sent.toNumber(), received: received.toNumber() };
  }

  async stats() {
    const entries = await Promise.all(
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
