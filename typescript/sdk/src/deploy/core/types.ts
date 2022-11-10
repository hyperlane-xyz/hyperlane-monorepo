import { Mailbox, MultisigIsm } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { ChainName } from '../../types';
import type { CheckerViolation } from '../types';

export type MultisigIsmConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig = {
  multisigIsm: MultisigIsmConfig;
  owner?: types.Address;
  remove?: boolean;
};

export enum CoreViolationType {
  MultisigIsm = 'MultisigIsm',
  Mailbox = 'Mailbox',
  ConnectionManager = 'ConnectionManager',
}

export enum MultisigIsmViolationType {
  EnrolledValidators = 'EnrolledValidators',
  Threshold = 'Threshold',
}

export enum MailboxViolationType {
  DefaultIsm = 'DefaultIsm',
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
  contract: MultisigIsm;
  subType: MultisigIsmViolationType;
  remote: ChainName;
}

export interface EnrolledValidatorsViolation extends MultisigIsmViolation {
  validatorManagerType: MultisigIsmViolationType.EnrolledValidators;
  actual: Set<types.Address>;
  expected: Set<types.Address>;
}

export interface ThresholdViolation extends MultisigIsmViolation {
  validatorManagerType: MultisigIsmViolationType.Threshold;
  actual: number;
  expected: number;
}
