import { BigNumber } from 'ethers';

import {
  CoreConfig,
  CoreViolationType,
  HyperlaneCore,
  HyperlaneCoreChecker,
  HyperlaneCoreDeployer,
  MailboxViolation,
  MailboxViolationType,
  OwnerViolation,
  ViolationType,
} from '@hyperlane-xyz/sdk';

import { HyperlaneAppGovernor } from '../govern/HyperlaneAppGovernor.js';

export class HyperlaneCoreGovernor extends HyperlaneAppGovernor<
  HyperlaneCore,
  CoreConfig
> {
  constructor(readonly checker: HyperlaneCoreChecker) {
    super(checker);
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

        this.pushCall(violation.chain, {
          to: violation.contract.address,
          data: violation.contract.interface.encodeFunctionData(
            'setDefaultIsm',
            [ismAddress],
          ),
          value: BigNumber.from(0),
          description: `Set ${violation.chain} Mailbox default ISM to ${ismAddress}`,
        });
        break;
      }
      default:
        throw new Error(`Unsupported mailbox violation type ${violation.type}`);
    }
  }

  protected async mapViolationsToCalls() {
    for (const violation of this.checker.violations) {
      switch (violation.type) {
        case ViolationType.Owner: {
          this.handleOwnerViolation(violation as OwnerViolation);
          break;
        }
        case CoreViolationType.Mailbox: {
          await this.handleMailboxViolation(violation as MailboxViolation);
          break;
        }
        case CoreViolationType.ValidatorAnnounce: {
          console.warn('Ignoring ValidatorAnnounce violation');
          break;
        }
        default:
          throw new Error(`Unsupported violation type ${violation.type}`);
      }
    }
  }
}
