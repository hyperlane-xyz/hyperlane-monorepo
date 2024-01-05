import { BigNumber } from 'ethers';

import { ChainMap } from '../../types';

export enum GasOracleContractType {
  StorageGasOracle = 'StorageGasOracle',
}
export type RemoteGasData = {
  tokenExchangeRate: BigNumber;
  gasPrice: BigNumber;
};
// Gas data to configure on a single local chain. Includes RemoteGasData
// for each remote chain.
export type StorageGasOracleConfig = RemoteGasData & {
  type: GasOracleContractType;
};
// StorageGasOracleConfig for each local chain
export type StorageGasOraclesConfig = ChainMap<StorageGasOracleConfig>;
