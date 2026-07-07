import chalk from 'chalk';
import { BigNumber } from 'ethers';

import {
  CheckerViolation,
  ChainName,
  CoreConfig,
  CoreViolationType,
  HyperlaneCore,
  HyperlaneCoreChecker,
  HyperlaneCoreDeployer,
  InterchainAccount,
  MailboxViolation,
  MailboxViolationType,
  MissingEnrolledRouterViolation,
  OwnerViolation,
  ProxyAdminViolation,
  RouterViolation,
  RouterViolationType,
  ViolationType,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, rootLogger } from '@hyperlane-xyz/utils';

import { chainsToSkip } from '../config/chain.js';
import { HyperlaneAppGovernor } from '../govern/HyperlaneAppGovernor.js';
import { HyperlaneICAChecker } from '../govern/HyperlaneICAChecker.js';

export class HyperlaneCoreGovernor extends HyperlaneAppGovernor<
  HyperlaneCore,
  CoreConfig
> {
  constructor(
    readonly checker: HyperlaneCoreChecker,
    readonly ica?: InterchainAccount,
    private readonly icaChecker?: HyperlaneICAChecker,
  ) {
    super(checker, ica);
  }

  async check(chainsToCheck?: ChainName[]) {
    await super.check(chainsToCheck);

    if (!this.icaChecker) return;

    const filtered = (chainsToCheck ?? this.checker.app.chains()).filter(
      (c) => !chainsToSkip.includes(c),
    );

    // Run only the enrollment check (not mailbox client or ownership) per chain.
    await Promise.allSettled(
      filtered.map((c) => this.icaChecker!.checkIcaRouterEnrollment(c)),
    );

    // Merge only enrollment violations into the core checker so mapViolationsToCalls picks them up.
    const enrollmentViolations = this.icaChecker.violations.filter(
      (v) =>
        v.type === RouterViolationType.MissingEnrolledRouter ||
        v.type === RouterViolationType.MisconfiguredEnrolledRouter,
    );
    this.checker.violations.push(...enrollmentViolations);
  }

  protected handleMissingEnrolledIcaRouterViolation(
    violation: MissingEnrolledRouterViolation,
  ) {
    const expectedDomains: number[] = [];
    const expectedAddresses: string[] = [];
    for (const remoteChain of violation.missingChains) {
      expectedDomains.push(this.checker.multiProvider.getDomainId(remoteChain));
      expectedAddresses.push(
        addressToBytes32(this.icaChecker!.app.routerAddress(remoteChain)),
      );
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
        description: `Enroll ${violation.missingChains.length} missing ICA remote router(s) on ${violation.chain}: ${violation.missingChains.join(', ')}`,
      },
    };
  }

  protected handleMisconfiguredEnrolledIcaRouterViolation(
    violation: RouterViolation,
  ) {
    const expectedDomains: number[] = [];
    const expectedAddresses: string[] = [];
    for (const [remoteChain, routerDiff] of Object.entries(
      violation.routerDiff,
    )) {
      expectedDomains.push(this.checker.multiProvider.getDomainId(remoteChain));
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
        description: `Fix misconfigured ICA routers on ${violation.chain} for chains: ${Object.keys(violation.routerDiff).join(', ')}`,
      },
    };
  }

  protected async handleMailboxViolation(violation: MailboxViolation) {
    switch (violation.subType) {
      case MailboxViolationType.DefaultIsm: {
        let ismAddress: string;
        if (typeof violation.expected === 'object') {
          // hack to bind the ISM factory to the deployer for verification
          new HyperlaneCoreDeployer(
            this.checker.multiProvider,
            this.checker.ismFactory,
          );
          const ism = await this.checker.ismFactory.deploy({
            destination: violation.chain,
            config: violation.expected,
          });
          ismAddress = ism.address;
        } else if (typeof violation.expected === 'string') {
          ismAddress = violation.expected;
        } else {
          throw new Error('Invalid mailbox violation expected value');
        }

        return {
          chain: violation.chain,
          call: {
            to: violation.contract.address,
            data: violation.contract.interface.encodeFunctionData(
              'setDefaultIsm',
              [ismAddress],
            ),
            value: BigNumber.from(0),
            description: `Set ${violation.chain} Mailbox default ISM to ${ismAddress}`,
          },
        };
      }
      default:
        throw new Error(`Unsupported mailbox violation type ${violation.type}`);
    }
  }

  public async mapViolationToCall(violation: CheckerViolation) {
    switch (violation.type) {
      case ViolationType.Owner: {
        return this.handleOwnerViolation(violation as OwnerViolation);
      }
      case CoreViolationType.Mailbox: {
        return this.handleMailboxViolation(violation as MailboxViolation);
      }
      case CoreViolationType.ValidatorAnnounce: {
        rootLogger.warn(chalk.yellow('Ignoring ValidatorAnnounce violation'));
        return undefined;
      }
      case ViolationType.ProxyAdmin: {
        return this.handleProxyAdminViolation(violation as ProxyAdminViolation);
      }
      case RouterViolationType.MissingEnrolledRouter: {
        return this.handleMissingEnrolledIcaRouterViolation(
          violation as MissingEnrolledRouterViolation,
        );
      }
      case RouterViolationType.MisconfiguredEnrolledRouter: {
        return this.handleMisconfiguredEnrolledIcaRouterViolation(
          violation as RouterViolation,
        );
      }
      default:
        throw new Error(
          `Unsupported violation type ${violation.type}: ${JSON.stringify(
            violation,
          )}`,
        );
    }
  }
}
