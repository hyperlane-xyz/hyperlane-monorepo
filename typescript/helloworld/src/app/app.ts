import { BigNumber } from 'ethers';

import { TypedListener } from '@abacus-network/core/dist/common';
import {
  AbacusApp,
  ChainName,
  ChainNameToDomainId,
  Remotes,
} from '@abacus-network/sdk';

import { ReceivedHelloWorldEvent } from '../types/contracts/HelloWorld';

import { HelloWorldContracts } from './contracts';

export class HelloWorldApp<
  Chain extends ChainName = ChainName,
> extends AbacusApp<HelloWorldContracts, Chain> {
  async sendHelloWorld<From extends Chain>(
    from: From,
    to: Remotes<Chain, From>,
    message: string,
    value: BigNumber,
    receiveHandler?: TypedListener<ReceivedHelloWorldEvent>,
  ): Promise<any> {
    const sender = this.getContracts(from).router;
    const toDomain = ChainNameToDomainId[to];
    const chainConnection = this.multiProvider.getChainConnection(from);

    // apply gas buffer due to https://github.com/abacus-network/abacus-monorepo/issues/634
    console.log('estimating');
    const estimated = await sender.estimateGas.sendHelloWorld(
      toDomain,
      message,
      chainConnection.overrides,
    );
    const gasLimit = estimated.mul(11).div(10);
    console.log({ value });
    console.log({ gasLimit });
    console.log(chainConnection.overrides);
    console.log(chainConnection.provider);

    const tx = await sender.populateTransaction.sendHelloWorld(
      toDomain,
      message,
      {
        ...chainConnection.overrides,
        gasLimit,
        gasPrice: 10e10,
        nonce: 497,
        value: 0,
      },
    );
    const checked = await chainConnection.signer?.checkTransaction(tx);
    console.log({ checked });
    console.log(await checked?.from);
    const populated = await chainConnection.signer?.populateTransaction(tx);
    console.log({ populated });
    console.log('sent!');
    console.log({ tx });
    const signed = await chainConnection.signer?.signTransaction(populated!);
    console.log(chainConnection.signer);
    console.log(
      'tx count',
      await chainConnection.provider.getTransactionCount(
        '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
      ),
    );
    console.log({ signed });
    const txactually = await chainConnection.provider.sendTransaction(signed!);
    console.log({ txactually });
    /*
    const receipt = await tx.wait(chainConnection.confirmations);
    console.log({ receipt });
    */

    if (receiveHandler) {
      const recipient = this.getContracts(to).router;
      const filter = recipient.filters.ReceivedHelloWorld(
        ChainNameToDomainId[from],
        ChainNameToDomainId[to],
      );
      recipient.once(filter, receiveHandler);
    }

    // return receipt;
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
