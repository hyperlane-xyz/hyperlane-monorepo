import { BigNumber } from 'ethers';

import {
  InterchainGasPaymaster,
  LegacyMultisigIsm,
  Mailbox,
  OverheadIgp,
} from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import type { CheckerViolation } from '../deploy/types';
import { ChainMap, ChainName } from '../types';

export enum GasOracleContractType {
  StorageGasOracle = 'StorageGasOracle',
}

export type InterchainGasPaymasterConfig = {
  beneficiary: types.Address;
  gasOracles: ChainMap<GasOracleContractType>;
};

export type MultisigIsmConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig = {
  multisigIsm: MultisigIsmConfig;
  owner: types.Address;
  igp: InterchainGasPaymasterConfig;
  remove?: boolean;
};

export enum CoreViolationType {
  MultisigIsm = 'MultisigIsm',
  Mailbox = 'Mailbox',
  ConnectionManager = 'ConnectionManager',
  ValidatorAnnounce = 'ValidatorAnnounce',
  InterchainGasPaymaster = 'InterchainGasPaymaster',
  DefaultIsmInterchainGasPaymaster = 'DefaultIsmInterchainGasPaymaster',
}

export enum MultisigIsmViolationType {
  EnrolledValidators = 'EnrolledValidators',
  Threshold = 'Threshold',
}

export enum MailboxViolationType {
  DefaultIsm = 'DefaultIsm',
}

export enum DefaultIsmIgpViolationType {
  DestinationGasOverheads = 'DestinationGasOverheads',
}

export enum IgpViolationType {
  Beneficiary = 'Beneficiary',
  GasOracles = 'GasOracles',
}

export interface MailboxViolation extends CheckerViolation {
  type: CoreViolationType.Mailbox;
  contract: Mailbox;
  mailboxType: MailboxViolationType;
}

export interface MailboxMultisigIsmViolation extends MailboxViolation {
  actual: types.Address;
  expected: types.Address;
}

export interface MultisigIsmViolation extends CheckerViolation {
  type: CoreViolationType.MultisigIsm;
  contract: LegacyMultisigIsm;
  subType: MultisigIsmViolationType;
  remote: ChainName;
}

export interface EnrolledValidatorsViolation extends MultisigIsmViolation {
  subType: MultisigIsmViolationType.EnrolledValidators;
  actual: Set<types.Address>;
  expected: Set<types.Address>;
}

export interface ThresholdViolation extends MultisigIsmViolation {
  subType: MultisigIsmViolationType.Threshold;
  actual: number;
  expected: number;
}

export interface ValidatorAnnounceViolation extends CheckerViolation {
  type: CoreViolationType.ValidatorAnnounce;
  chain: ChainName;
  validator: types.Address;
  actual: boolean;
  expected: boolean;
}

export interface IgpViolation extends CheckerViolation {
  type: CoreViolationType.InterchainGasPaymaster;
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

export interface DefaultIsmIgpViolation extends CheckerViolation {
  type: CoreViolationType.DefaultIsmInterchainGasPaymaster;
  contract: OverheadIgp;
  subType: DefaultIsmIgpViolationType;
}

export interface DefaultIsmIgpDestinationGasOverheadsViolation
  extends DefaultIsmIgpViolation {
  subType: DefaultIsmIgpViolationType.DestinationGasOverheads;
  actual: ChainMap<BigNumber>;
  expected: ChainMap<BigNumber>;
}
