import { Mailbox } from '@hyperlane-xyz/core';
import type { Address } from '@hyperlane-xyz/utils';

import { UpgradeConfig } from '../deploy/proxy';
import type { CheckerViolation } from '../deploy/types';
import { IsmConfig } from '../ism/types';
import { ChainName } from '../types';

export type CoreConfig = {
  defaultIsm: IsmConfig;
  owner: Address;
  remove?: boolean;
  upgrade?: UpgradeConfig;
};

export enum CoreViolationType {
  Mailbox = 'Mailbox',
  ConnectionManager = 'ConnectionManager',
  ValidatorAnnounce = 'ValidatorAnnounce',
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
  actual: Address;
  expected: IsmConfig;
}

export interface ValidatorAnnounceViolation extends CheckerViolation {
  type: CoreViolationType.ValidatorAnnounce;
  chain: ChainName;
  validator: Address;
  actual: boolean;
  expected: boolean;
}
