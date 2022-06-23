import { ChainMap, ChainName, IChainConnection } from '../types';
import { MultiGeneric, objMap } from '../utils';

import { ChainConnection } from './ChainConnection';

export class MultiProvider<
  Chain extends ChainName = ChainName,
> extends MultiGeneric<Chain, ChainConnection> {
  constructor(chainConnectionConfigs: ChainMap<Chain, IChainConnection>) {
    super(
      objMap(
        chainConnectionConfigs,
        (_, connection) => new ChainConnection(connection),
      ),
    );
  }
  getChainConnection(chain: Chain): ChainMap<Chain, ChainConnection>[Chain] {
    return this.get(chain);
  }
  // This doesn't work on hardhat providers so we skip for now
  // ready() {
  //   return Promise.all(this.values().map((dc) => dc.provider!.ready));
  // }
}
