import { LegacyMultisigIsm, Mailbox } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import type { CheckerViolation } from '../deploy/types';
import { ChainName } from '../types';

export type MultisigIsmConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig = {
  multisigIsm: MultisigIsmConfig;
  owner: types.Address;
  remove?: boolean;
};

export enum CoreViolationType {
  MultisigIsm = 'MultisigIsm',
  Mailbox = 'Mailbox',
  ConnectionManager = 'ConnectionManager',
  ValidatorAnnounce = 'ValidatorAnnounce',
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
