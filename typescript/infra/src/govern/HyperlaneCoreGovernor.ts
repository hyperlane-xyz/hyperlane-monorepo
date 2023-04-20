import {
  ChainMap,
  CoreConfig,
  HyperlaneCore,
  HyperlaneCoreChecker,
  OwnerViolation,
  ViolationType,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneAppGovernor } from '../govern/HyperlaneAppGovernor';

export class HyperlaneCoreGovernor extends HyperlaneAppGovernor<
  HyperlaneCore,
  CoreConfig
> {
  constructor(checker: HyperlaneCoreChecker, owners: ChainMap<types.Address>) {
    super(checker, owners);
  }

  protected async mapViolationsToCalls() {
    for (const violation of this.checker.violations) {
      switch (violation.type) {
        case ViolationType.Owner: {
          this.handleOwnerViolation(violation as OwnerViolation);
          break;
        }
        default:
          throw new Error(`Unsupported violation type ${violation.type}`);
      }
    }
  }
}
