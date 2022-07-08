import { TypedListener } from '@abacus-network/core/dist/common';
import {
  AbacusApp,
  ChainName,
  ChainNameToDomainId,
  Remotes,
} from '@abacus-network/sdk';
import { ethers } from 'ethers';
import { ReceivedHelloWorldEvent } from '../types/contracts/HelloWorld';
import { HelloWorldContracts } from './contracts';

export class HelloWorldApp<
  Chain extends ChainName = ChainName,
> extends AbacusApp<HelloWorldContracts, Chain> {
  async sendHelloWorld<From extends Chain>(
    from: From,
    to: Remotes<Chain, From>,
    message: string,
    receiveHandler?: TypedListener<ReceivedHelloWorldEvent>,
  ): Promise<ethers.ContractReceipt> {
    const sender = this.getContracts(from).router;
    const toDomain = ChainNameToDomainId[to];
    const chainConnection = this.multiProvider.getChainConnection(from);
    const tx = await sender.sendHelloWorld(
      toDomain,
      message,
      chainConnection.overrides,
    );
    const receipt = await tx.wait(chainConnection.confirmations);

    if (receiveHandler) {
      const recipient = this.getContracts(to).router;
      const filter = recipient.filters.ReceivedHelloWorld(
        ChainNameToDomainId[from],
        ChainNameToDomainId[to],
      );
      recipient.once(filter, receiveHandler);
    }

    return receipt;
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
