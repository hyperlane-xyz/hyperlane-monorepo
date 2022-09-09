import { Mailbox, MultisigZone } from '@abacus-network/core';
import type { types } from '@abacus-network/utils';

import { ChainName } from '../../types';
import type { CheckerViolation } from '../types';

export type MultisigZoneConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig = {
  validatorManager: MultisigZoneConfig;
  owner?: types.Address;
  remove?: boolean;
};

export enum CoreViolationType {
  MultisigZone = 'MultisigZone',
  Mailbox = 'Mailbox',
  AbacusConnectionManager = 'AbacusConnectionManager',
}

export enum MultisigZoneViolationType {
  EnrolledValidators = 'EnrolledValidators',
  Threshold = 'Threshold',
}

export enum AbacusConnectionManagerViolationType {
  EnrolledInboxes = 'EnrolledInboxes',
}

export enum MailboxViolationType {
  DefaultZone = 'DefaultZone',
}

export interface MailboxViolation extends CheckerViolation {
  type: CoreViolationType.Mailbox;
  contract: Mailbox;
  mailboxType: MailboxViolationType;
}

export interface MailboxMultisigZoneViolation extends MailboxViolation {
  actual: types.Address;
  expected: types.Address;
}

export interface MultisigZoneViolation extends CheckerViolation {
  type: CoreViolationType.MultisigZone;
  contract: MultisigZone;
  zoneType: MultisigZoneViolationType;
  remote: ChainName;
}

export interface EnrolledValidatorsViolation extends MultisigZoneViolation {
  validatorManagerType: MultisigZoneViolationType.EnrolledValidators;
  actual: Set<types.Address>;
  expected: Set<types.Address>;
}

export interface ThresholdViolation extends MultisigZoneViolation {
  validatorManagerType: MultisigZoneViolationType.Threshold;
  actual: number;
  expected: number;
}
