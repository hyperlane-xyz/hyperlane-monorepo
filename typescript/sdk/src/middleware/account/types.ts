import { InterchainAccountRouter } from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { CheckerViolation } from '../../deploy/types';

export enum InterchainAccountViolationType {
  InterchainSecurityModule = 'InterchainSecurityModule',
}

export interface InterchainAccountViolation extends CheckerViolation {
  type: InterchainAccountViolationType;
  contract: InterchainAccountRouter;
  mailbox: types.Address;
}
