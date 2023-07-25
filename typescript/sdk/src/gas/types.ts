import { BigNumber } from 'ethers';

import { InterchainGasPaymaster, OverheadIgp } from '@hyperlane-xyz/core';
import type { Address } from '@hyperlane-xyz/utils';

import { UpgradeConfig } from '../deploy/proxy';
import type { CheckerViolation } from '../deploy/types';
import { ChainMap } from '../types';

export enum GasOracleContractType {
  StorageGasOracle = 'StorageGasOracle',
}

export type IgpConfig = {
  owner: Address;
  beneficiary: Address;
  gasOracleType: ChainMap<GasOracleContractType>;
  oracleKey: Address;
  upgrade?: UpgradeConfig;
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
  actual: Address;
  expected: Address;
}

export interface IgpGasOraclesViolation extends IgpViolation {
  subType: IgpViolationType.GasOracles;
  contract: InterchainGasPaymaster;
  actual: ChainMap<Address>;
  expected: ChainMap<Address>;
}

export interface IgpOverheadViolation extends IgpViolation {
  subType: IgpViolationType.Overhead;
  contract: OverheadIgp;
  actual: ChainMap<BigNumber>;
  expected: ChainMap<BigNumber>;
}
