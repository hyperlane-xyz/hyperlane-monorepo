import type { Mailbox } from '@hyperlane-xyz/core';
import type { Address, ParsedMessage } from '@hyperlane-xyz/utils';

import type { UpgradeConfig } from '../deploy/proxy';
import type { CheckerViolation } from '../deploy/types';
import { HookConfig } from '../hook/types';
import type { IsmConfig } from '../ism/types';
import type { ChainName } from '../types';

export type CoreConfig = {
  defaultIsm: IsmConfig;
  defaultHook: HookConfig;
  requiredHook: HookConfig;
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
  subType: MailboxViolationType;
  contract: Mailbox;
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

export type DispatchedMessage = {
  id: string;
  message: string;
  parsed: ParsedMessage;
};
