import {
  ChainMap,
  ConnectionClientViolation,
  ConnectionClientViolationType,
  HyperlaneAppChecker,
  OwnerViolation,
  RouterApp,
  RouterConfig,
  RouterViolation,
  RouterViolationType,
  ViolationType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneAppGovernor } from './HyperlaneAppGovernor';

export class ProxiedRouterGovernor<
  App extends RouterApp<any>,
  Config extends RouterConfig,
> extends HyperlaneAppGovernor<App, Config> {
  constructor(
    checker: HyperlaneAppChecker<App, Config>,
    owners: ChainMap<Address>,
  ) {
    super(checker, owners);
  }

  protected async mapViolationsToCalls() {
    for (const violation of this.checker.violations) {
      switch (violation.type) {
        case ConnectionClientViolationType.InterchainSecurityModule:
          this.handleIsmViolation(violation as ConnectionClientViolation);
          break;
        case RouterViolationType.EnrolledRouter:
          this.handleEnrolledRouterViolation(violation as RouterViolation);
          break;
        case ViolationType.Owner:
          this.handleOwnerViolation(violation as OwnerViolation);
          break;
        default:
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

  protected handleEnrolledRouterViolation(violation: RouterViolation) {
    const remoteDomain = this.checker.multiProvider.getDomainId(
      violation.remoteChain,
    );
    this.pushCall(violation.chain, {
      to: violation.contract.address,
      data: violation.contract.interface.encodeFunctionData(
        'enrollRemoteRouter',
        [remoteDomain, violation.expected],
      ),
      description: `Enroll router for remote chain ${violation.remoteChain} (${remoteDomain}) ${violation.expected} in ${violation.contract.address}`,
    });
  }
}
