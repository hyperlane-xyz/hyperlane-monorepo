import {
  ChainMap,
  ConnectionClientViolation,
  ConnectionClientViolationType,
  HyperlaneAppChecker,
  RouterApp,
  RouterConfig,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneAppGovernor } from './HyperlaneAppGovernor';

export class ProxiedRouterGovernor<
  App extends RouterApp<any>,
  Config extends RouterConfig,
> extends HyperlaneAppGovernor<App, Config> {
  constructor(
    checker: HyperlaneAppChecker<App, Config>,
    owners: ChainMap<types.Address>,
  ) {
    super(checker, owners);
  }

  protected async mapViolationsToCalls() {
    for (const violation of this.checker.violations) {
      if (
        violation.type ===
        ConnectionClientViolationType.InterchainSecurityModule
      ) {
        this.handleIsmViolation(violation as ConnectionClientViolation);
      } else {
        throw new Error(`Unsupported violation type ${violation.type}`);
      }
    }
  }

  protected handleIsmViolation(violation: ConnectionClientViolation) {
    this.pushCall(violation.chain, {
      to: violation.contract.address,
      data: violation.contract.interface.encodeFunctionData(
        'setInterchainSecurityModule',
        [violation.expected],
      ),
      description: `Set ISM of ${violation.contract.address} to ${violation.expected}`,
    });
  }
}
