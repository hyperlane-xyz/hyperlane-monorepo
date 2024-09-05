import { BigNumber } from 'ethers';

import {
  ChainName,
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
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneAppGovernor } from './HyperlaneAppGovernor.js';

export class ProxiedRouterGovernor<
  App extends RouterApp<any>,
  Config extends RouterConfig,
> extends HyperlaneAppGovernor<App, Config> {
  public async mapViolationToCall(violation: CheckerViolation) {
    switch (violation.type) {
      case ConnectionClientViolationType.InterchainSecurityModule:
        return this.handleIsmViolation(violation as ConnectionClientViolation);
      case RouterViolationType.EnrolledRouter:
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
    const domains: number[] = [];
    const addresses: string[] = [];

    for (const [remoteChain, expectedRouter] of Object.entries(
      violation.routerDiff,
    ) as [ChainName, Address][]) {
      const remoteDomain = this.checker.multiProvider.getDomainId(remoteChain);
      domains.push(remoteDomain);
      addresses.push(expectedRouter);
    }

    return {
      chain: violation.chain,
      call: {
        to: violation.contract.address,
        data: violation.contract.interface.encodeFunctionData(
          'enrollRemoteRouters',
          [domains, addresses],
        ),
        value: BigNumber.from(0),
        description: `Enroll missing routers for ${
          domains.length
        } remote chains ${domains.join(', ')} in ${violation.contract.address}`,
      },
    };
  }
}
