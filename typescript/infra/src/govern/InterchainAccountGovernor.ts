import {
  ChainMap,
  InterchainAccount,
  InterchainAccountChecker,
  InterchainAccountConfig,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneAppGovernor } from './HyperlaneAppGovernor';

export class InterchainAccountGovernor extends HyperlaneAppGovernor<
  InterchainAccount,
  InterchainAccountConfig
> {
  constructor(
    checker: InterchainAccountChecker,
    owners: ChainMap<types.Address>,
  ) {
    super(checker, owners);
  }

  protected async mapViolationsToCalls() {
    throw new Error('governor not implemented for account middleware');
  }
}
