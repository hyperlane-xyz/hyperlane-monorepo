import {
  ChainMap,
  CoreConfig,
  CoreViolationType,
  HyperlaneCore,
  HyperlaneCoreChecker,
  OwnerViolation,
  ViolationType,
} from '@hyperlane-xyz/sdk';
import {
  MailboxViolation,
  MailboxViolationType,
} from '@hyperlane-xyz/sdk/dist/core/types';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneAppGovernor } from '../govern/HyperlaneAppGovernor';

export class HyperlaneCoreGovernor extends HyperlaneAppGovernor<
  HyperlaneCore,
  CoreConfig
> {
  constructor(
    readonly checker: HyperlaneCoreChecker,
    owners: ChainMap<types.Address>,
  ) {
    super(checker, owners);
  }

  protected async handleMailboxViolation(violation: MailboxViolation) {
    switch (violation.mailboxType) {
      case MailboxViolationType.DefaultIsm: {
        const ism = await this.checker.ismFactory.deploy(
          violation.chain,
          violation.expected,
        );
        this.pushCall(violation.chain, {
          to: violation.contract.address,
          data: violation.contract.interface.encodeFunctionData(
            'setDefaultIsm',
            [ism.address],
          ),
          description: `Set ${violation.chain} Mailbox default ISM to ${ism.address}`,
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
