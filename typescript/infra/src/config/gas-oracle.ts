import { BigNumber } from 'ethers';

import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

export type RemoteGasData = {
  tokenExchangeRate: BigNumber;
  gasPrice: BigNumber;
};

export type RemoteGasDataConfig = RemoteGasData & {
  remoteDomain: number;
};

export type StorageGasOracleConfig<Chain extends ChainName> = Partial<
  ChainMap<Chain, RemoteGasData>
>;

export type AllStorageGasOracleConfigs<Chain extends ChainName> = ChainMap<
  Chain,
  StorageGasOracleConfig<Chain>
>;
