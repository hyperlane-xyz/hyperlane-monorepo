import { BigNumber } from 'ethers';

export enum GasOracleContractType {
  StorageGasOracle = 'StorageGasOracle',
}

// Gas data to configure on a single destination chain.
export type DestinationOracleConfig = {
  tokenExchangeRate: BigNumber;
  gasPrice: BigNumber;
};
