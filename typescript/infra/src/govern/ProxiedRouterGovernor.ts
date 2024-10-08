import { BigNumber } from 'ethers';

import {
  CheckerViolation,
  ConnectionClientViolation,
  ConnectionClientViolationType,
  OwnerViolation,
  RouterApp,
  RouterConfig,
  RouterViolation,
  RouterViolationType,
  ViolationType,
} from '@hyperlane-xyz/sdk';

import { HyperlaneAppGovernor } from './HyperlaneAppGovernor.js';

export class ProxiedRouterGovernor<
  App extends RouterApp<any>,
  Config extends RouterConfig,
> extends HyperlaneAppGovernor<App, Config> {
  protected async mapViolationToCall(violation: CheckerViolation) {
    switch (violation.type) {
      case ConnectionClientViolationType.InterchainSecurityModule:
        return this.handleIsmViolation(violation as ConnectionClientViolation);
      case RouterViolationType.EnrolledRouter:
        return this.handleEnrolledRouterViolation(violation as RouterViolation);
      case ViolationType.Owner:
        return this.handleOwnerViolation(violation as OwnerViolation);
      default:
        throw new Error(
          `Unsupported violation type ${violation.type}: ${JSON.stringify(
            violation,
          )}`,
        );
    }
  }

  protected handleIsmViolation(violation: ConnectionClientViolation) {
    return {
      chain: violation.chain,
      call: {
        to: violation.contract.address,
        data: violation.contract.interface.encodeFunctionData(
          'setInterchainSecurityModule',
          [violation.expected],
        ),
        value: BigNumber.from(0),
        description: `Set ISM of ${violation.contract.address} to ${violation.expected}`,
      },
    };
  }

  protected handleEnrolledRouterViolation(violation: RouterViolation) {
    const remoteDomain = this.checker.multiProvider.getDomainId(
      violation.remoteChain,
    );
    return {
      chain: violation.chain,
      call: {
        to: violation.contract.address,
        data: violation.contract.interface.encodeFunctionData(
          'enrollRemoteRouter',
          [remoteDomain, violation.expected],
        ),
        value: BigNumber.from(0),
        description: `Enroll router for remote chain ${violation.remoteChain} (${remoteDomain}) ${violation.expected} in ${violation.contract.address}`,
      },
    };
  }
}
