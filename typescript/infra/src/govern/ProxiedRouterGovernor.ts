import { BigNumber } from 'ethers';

import {
  CheckerViolation,
  ConnectionClientViolation,
  ConnectionClientViolationType,
  OwnerViolation,
  ProxyAdminViolation,
  RouterApp,
  RouterConfig,
  RouterViolation,
  RouterViolationType,
  ViolationType,
} from '@hyperlane-xyz/sdk';
import { stringifyObject } from '@hyperlane-xyz/utils';

import { HyperlaneAppGovernor } from './HyperlaneAppGovernor.js';

export class ProxiedRouterGovernor<
  App extends RouterApp<any>,
  Config extends RouterConfig,
> extends HyperlaneAppGovernor<App, Config> {
  public async mapViolationToCall(violation: CheckerViolation) {
    switch (violation.type) {
      case ConnectionClientViolationType.InterchainSecurityModule:
        return this.handleIsmViolation(violation as ConnectionClientViolation);
      case RouterViolationType.MisconfiguredEnrolledRouter:
        return this.handleEnrolledRouterViolation(violation as RouterViolation);
      case ViolationType.Owner:
        return this.handleOwnerViolation(violation as OwnerViolation);
      case ViolationType.ProxyAdmin:
        return this.handleProxyAdminViolation(violation as ProxyAdminViolation);
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
    const expectedDomains: number[] = [];
    const expectedAddresses: string[] = [];

    for (const [remoteChain, routerDiff] of Object.entries(
      violation.routerDiff,
    )) {
      const remoteDomain = this.checker.multiProvider.getDomainId(remoteChain);
      expectedDomains.push(remoteDomain);
      expectedAddresses.push(routerDiff.expected);
    }

    return {
      chain: violation.chain,
      call: {
        to: violation.contract.address,
        data: violation.contract.interface.encodeFunctionData(
          'enrollRemoteRouters',
          [expectedDomains, expectedAddresses],
        ),
        value: BigNumber.from(0),
        description: `Updating routers in ${violation.contract.address} for ${expectedDomains.length} remote chains`,
        expandedDescription: `Updating routers for chains ${Object.keys(
          violation.routerDiff,
        ).join(', ')}:\n${stringifyObject(violation.routerDiff)}`,
      },
    };
  }
}
