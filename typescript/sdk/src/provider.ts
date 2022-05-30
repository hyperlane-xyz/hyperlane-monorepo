import { ethers } from 'ethers';

import { ChainMap, ChainName } from './types';
import { MultiGeneric, objMap } from './utils';

export interface IChainConnection {
  provider: ethers.providers.Provider;
  signer?: ethers.Signer;
  overrides?: ethers.Overrides;
  confirmations?: number;
}

export class ChainConnection {
  provider: ethers.providers.Provider;
  signer?: ethers.Signer;
  overrides: ethers.Overrides;
  confirmations: number;

  constructor(dc: IChainConnection) {
    this.provider = dc.provider;
    this.signer = dc.signer;
    this.overrides = dc.overrides ?? {};
    this.confirmations = dc.confirmations ?? 0;
  }

  getConnection = (): ethers.providers.Provider | ethers.Signer =>
    this.signer ?? this.provider;

  getAddress = (): Promise<string> | undefined => this.signer?.getAddress();
}

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
