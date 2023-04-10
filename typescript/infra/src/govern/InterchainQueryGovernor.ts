import {
  ChainMap,
  InterchainQuery,
  InterchainQueryChecker,
  InterchainQueryConfig,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneAppGovernor } from './HyperlaneAppGovernor';

export class InterchainQueryGovernor extends HyperlaneAppGovernor<
  InterchainQuery,
  InterchainQueryConfig
> {
  constructor(
    checker: InterchainQueryChecker,
    owners: ChainMap<types.Address>,
  ) {
    super(checker, owners);
  }

  protected async mapViolationsToCalls() {
    throw new Error('governor not implemented for query middleware');
  }
}
