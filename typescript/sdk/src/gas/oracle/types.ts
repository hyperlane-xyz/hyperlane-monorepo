import { BigNumber } from 'ethers';

import { ChainMap } from '../../types';

export enum GasOracleContractType {
  StorageGasOracle = 'StorageGasOracle',
}
// Gas data to configure on a single destination chain.
export type StorageGasOracleConfig = {
  tokenExchangeRate: BigNumber;
  gasPrice: BigNumber;
};
// StorageGasOracleConfig for each local chain
export type StorageGasOraclesConfig = ChainMap<StorageGasOracleConfig>;

export type OracleConfig = {
  oracleConfig: StorageGasOraclesConfig;
};
