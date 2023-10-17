import {
  ChainMap,
  CoreConfig,
  CoreViolationType,
  HyperlaneCore,
  HyperlaneCoreChecker,
  MailboxViolation,
  MailboxViolationType,
  OwnerViolation,
  ViolationType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneAppGovernor } from '../govern/HyperlaneAppGovernor';

export class HyperlaneCoreGovernor extends HyperlaneAppGovernor<
  HyperlaneCore,
  CoreConfig
> {
  constructor(
    readonly checker: HyperlaneCoreChecker,
    owners: ChainMap<Address>,
  ) {
    super(checker, owners);
  }

  protected async handleMailboxViolation(violation: MailboxViolation) {
    switch (violation.subType) {
      case MailboxViolationType.DefaultIsm: {
        let ismAddress: string;
        if (typeof violation.expected === 'object') {
          const ism = await this.checker.ismFactory.deploy(
            violation.chain,
            violation.expected,
          );
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
        default:
          throw new Error(`Unsupported violation type ${violation.type}`);
      }
    }
  }
}
