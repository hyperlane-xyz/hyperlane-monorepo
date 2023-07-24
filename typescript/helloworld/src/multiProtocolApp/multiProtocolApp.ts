import { BigNumber } from 'ethers';

import {
  ChainMap,
  ChainName,
  IGasRouterAdapter,
  MultiProtocolGasRouterApp,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { StatCounts } from '../app/types';

interface HelloWorldAdapter extends IGasRouterAdapter {
  sendHelloWorld: (
    from: ChainName,
    to: ChainName,
    message: string,
    value: BigNumber,
  ) => Promise<string>;

  channelStats: (from: ChainName, to: ChainName) => Promise<StatCounts>;
  stats: () => Promise<ChainMap<ChainMap<StatCounts>>>;
}

export class HelloMultiProtocolApp extends MultiProtocolGasRouterApp<
  { router: Address },
  HelloWorldAdapter
> {
  sendHelloWorld(
    from: ChainName,
    to: ChainName,
    message: string,
    value: BigNumber,
  ): Promise<string> {
    return this.adapter(from).sendHelloWorld(from, to, message, value);
  }

  channelStats(from: ChainName, to: ChainName): Promise<StatCounts> {
    return this.adapter(from).channelStats(from, to);
  }

  async stats(): Promise<ChainMap<ChainMap<StatCounts>>> {
    const entries: Array<[ChainName, ChainMap<StatCounts>]> = await Promise.all(
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
