import {
  ChainMap,
  ChainName,
  MultiProtocolRouterApp,
  RouterAddress,
  TypedTransaction,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { StatCounts } from '../app/types.js';

import { EvmHelloWorldAdapter } from './evmAdapter.js';
import { SealevelHelloWorldAdapter } from './sealevelAdapter.js';
import { IHelloWorldAdapter } from './types.js';

export class HelloMultiProtocolApp extends MultiProtocolRouterApp<
  IHelloWorldAdapter,
  RouterAddress & { mailbox: Address }
> {
  override protocolToAdapter(protocol: ProtocolType) {
    if (protocol === ProtocolType.Ethereum) return EvmHelloWorldAdapter;
    if (protocol === ProtocolType.Sealevel) return SealevelHelloWorldAdapter;
    throw new Error(`No adapter for protocol ${protocol}`);
  }

  populateHelloWorldTx(
    origin: ChainName,
    destination: ChainName,
    message: string,
    value: string,
    sender: Address,
  ): Promise<TypedTransaction> {
    return this.adapter(origin).populateSendHelloTx(
      destination,
      message,
      value,
      sender,
    );
  }

  async channelStats(
    origin: ChainName,
    destination: ChainName,
  ): Promise<StatCounts> {
    const [sent, received] = await Promise.all([
      this.adapter(origin).sentStat(destination),
      this.adapter(destination).sentStat(origin),
    ]);
    return { sent, received };
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
