import { InterchainAccountIsm__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  InterchainAccount,
  InterchainAccountChecker,
  InterchainAccountConfig,
  InterchainAccountViolation,
  InterchainAccountViolationType,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneAppGovernor } from './HyperlaneAppGovernor';

export class InterchainAccountGovernor extends HyperlaneAppGovernor<
  InterchainAccount,
  InterchainAccountConfig
> {
  constructor(
    checker: InterchainAccountChecker,
    owners: ChainMap<types.Address>,
  ) {
    super(checker, owners);
  }

  protected async mapViolationsToCalls() {
    for (const violation of this.checker.violations) {
      switch (violation.type) {
        case InterchainAccountViolationType.InterchainSecurityModule: {
          this.handleInterchainSecurityModuleViolation(
            violation as InterchainAccountViolation,
          );
          break;
        }
        default:
          throw new Error(`Unsupported violation type ${violation.type}`);
      }
    }
  }

  protected async handleInterchainSecurityModuleViolation(
    violation: InterchainAccountViolation,
  ) {
    const signer = this.checker.multiProvider.getSigner(violation.chain);
    const factory = new InterchainAccountIsm__factory(signer);
    const ism = await factory.deploy(violation.mailbox);
    this.pushCall(violation.chain, {
      to: violation.contract.address,
      data: violation.contract.interface.encodeFunctionData(
        'setInterchainSecurityModule',
        [ism.address],
      ),
      description: `Set ISM for ICA at ${violation.contract.address} from ${violation.actual} to ${ism.address}`,
    });
  }
}
