import { AllChains } from '../consts/chains';
import {
  ChainName,
  IChainConnection,
  PartialChainMap,
  Remotes,
} from '../types';
import { partialObjMap } from '../utils';

import { ChainConnection } from './ChainConnection';

export class MultiProvider {
  public readonly chainMap: PartialChainMap<ChainConnection>;

  constructor(chainConnectionConfigs: PartialChainMap<IChainConnection>) {
    this.chainMap = partialObjMap(
      chainConnectionConfigs,
      (_, connection) => new ChainConnection(connection),
    );
  }

  // Throws if chain is invalid or has not been set
  getChainConnection(chain: ChainName): ChainConnection {
    if (!chain || !AllChains.includes(chain)) {
      throw new Error(`Invalid chain ${chain}`);
    }
    const connection = this.chainMap[chain] ?? null;
    if (!connection) {
      throw new Error(`No chain connection found for ${chain}`);
    }
    return connection;
  }

  // Returns null if chain connection has not been set
  tryGetChainConnection(chain: ChainName): ChainConnection | null {
    if (!chain || !AllChains.includes(chain)) {
      return null;
    }
    return this.chainMap[chain] ?? null;
  }

  setChainConnection(
    chain: ChainName,
    chainConnectionConfig: IChainConnection,
  ): ChainConnection {
    if (this.tryGetChainConnection(chain)) {
      throw new Error(`Connection already exists for chain ${chain}`);
    }
    const connection = new ChainConnection(chainConnectionConfig);
    this.chainMap[chain] = connection;
    return connection;
  }

  chains<Chain extends ChainName>(): Chain[] {
    return Object.keys(this.chainMap) as Chain[];
  }

  remoteChains<Chain extends ChainName>(name: Chain): Remotes<Chain, Chain>[] {
    return this.chains().filter((key) => key !== name) as Remotes<
      Chain,
      Chain
    >[];
  }

  // This doesn't work on hardhat providers so we skip for now
  // ready() {
  //   return Promise.all(this.values().map((dc) => dc.provider!.ready));
  // }
}
