import { BigNumber } from 'ethers';

import { InterchainGasPaymaster, OverheadIgp } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import type { CheckerViolation } from '../deploy/types';
import { ChainMap } from '../types';

export enum GasOracleContractType {
  StorageGasOracle = 'StorageGasOracle',
}

export type IgpConfig = {
  owner: types.Address;
  beneficiary: types.Address;
  gasOracleType: ChainMap<GasOracleContractType>;
};

export type OverheadIgpConfig = IgpConfig & {
  overhead: ChainMap<number>;
};

export enum IgpViolationType {
  Beneficiary = 'Beneficiary',
  GasOracles = 'GasOracles',
  Overhead = 'Overhead',
}

export interface IgpViolation extends CheckerViolation {
  type: 'InterchainGasPaymaster';
  subType: IgpViolationType;
}

export interface IgpBeneficiaryViolation extends IgpViolation {
  subType: IgpViolationType.Beneficiary;
  contract: InterchainGasPaymaster;
  actual: types.Address;
  expected: types.Address;
}

export interface IgpGasOraclesViolation extends IgpViolation {
  subType: IgpViolationType.GasOracles;
  contract: InterchainGasPaymaster;
  actual: ChainMap<types.Address>;
  expected: ChainMap<types.Address>;
}

export interface IgpOverheadViolation extends IgpViolation {
  subType: IgpViolationType.Overhead;
  contract: OverheadIgp;
  actual: ChainMap<BigNumber>;
  expected: ChainMap<BigNumber>;
}
