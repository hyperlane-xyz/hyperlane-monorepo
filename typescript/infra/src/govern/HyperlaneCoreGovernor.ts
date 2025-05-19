import chalk from 'chalk';
import { BigNumber } from 'ethers';

import {
  CheckerViolation,
  CoreConfig,
  CoreViolationType,
  HyperlaneCore,
  HyperlaneCoreChecker,
  HyperlaneCoreDeployer,
  InterchainAccount,
  MailboxViolation,
  MailboxViolationType,
  OwnerViolation,
  ProxyAdminViolation,
  ViolationType,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneAppGovernor } from '../govern/HyperlaneAppGovernor.js';

export class HyperlaneCoreGovernor extends HyperlaneAppGovernor<
  HyperlaneCore,
  CoreConfig
> {
  constructor(
    readonly checker: HyperlaneCoreChecker,
    readonly ica?: InterchainAccount,
  ) {
    super(checker, ica);
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
      default:
        throw new Error(
          `Unsupported violation type ${violation.type}: ${JSON.stringify(
            violation,
          )}`,
        );
    }
  }
}
