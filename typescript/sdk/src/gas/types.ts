import { InterchainGasPaymaster } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import type { CheckerViolation } from '../deploy';
import { ChainMap } from '../types';

export enum GasOracleContractType {
  StorageGasOracle = 'StorageGasOracle',
}

export type IgpConfig = {
  // Proxy admin
  // Threshold on each chain
  // Beneficiary
};

export type InterchainGasPaymasterConfig = {
  beneficiary: types.Address;
  gasOracles: ChainMap<GasOracleContractType>;
};

export enum IgpViolationType {
  Beneficiary = 'Beneficiary',
  GasOracles = 'GasOracles',
}

export interface IgpViolation extends CheckerViolation {
  type: 'InterchainGasPaymaster';
  contract: InterchainGasPaymaster;
  subType: IgpViolationType;
}

export interface IgpBeneficiaryViolation extends IgpViolation {
  subType: IgpViolationType.Beneficiary;
  actual: types.Address;
  expected: types.Address;
}

export interface IgpGasOraclesViolation extends IgpViolation {
  subType: IgpViolationType.GasOracles;
  actual: ChainMap<types.Address>;
  expected: ChainMap<types.Address>;
}
