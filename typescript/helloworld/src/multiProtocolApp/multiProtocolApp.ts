import {
  ChainMap,
  ChainName,
  MultiProtocolRouterApp,
  RouterAddress,
  TypedTransaction,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { StatCounts } from '../app/types';

import { EvmHelloWorldAdapter } from './evmAdapter';
import { SealevelHelloWorldAdapter } from './sealevelAdapter';
import { IHelloWorldAdapter } from './types';

export class HelloMultiProtocolApp extends MultiProtocolRouterApp<
  RouterAddress & { mailbox: Address },
  IHelloWorldAdapter
> {
  override protocolToAdapter(protocol: ProtocolType) {
    if (protocol === ProtocolType.Ethereum) return EvmHelloWorldAdapter;
    if (protocol === ProtocolType.Sealevel) return SealevelHelloWorldAdapter;
    throw new Error(`No adapter for protocol ${protocol}`);
  }

  populateHelloWorldTx(
    from: ChainName,
    to: ChainName,
    message: string,
    value: string,
    sender: Address,
  ): Promise<TypedTransaction> {
    return this.adapter(from).populateSendHelloTx(
      from,
      to,
      message,
      value,
      sender,
    );
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
