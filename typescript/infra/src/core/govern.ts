import {
  ChainMap,
  ChainName,
  CoreConfig,
  CoreViolationType,
  EnrolledValidatorsViolation,
  HyperlaneCore,
  HyperlaneCoreChecker,
  MultisigIsmViolation,
  MultisigIsmViolationType,
  OwnerViolation,
  ProxyViolation,
  ViolationType,
} from '@hyperlane-xyz/sdk';
import { ProxyKind } from '@hyperlane-xyz/sdk/dist/proxy';
import { types, utils } from '@hyperlane-xyz/utils';

import {
  AnnotatedCallData,
  HyperlaneAppGovernor,
} from '../govern/HyperlaneAppGovernor';

export class HyperlaneCoreGovernor extends HyperlaneAppGovernor<
  HyperlaneCore,
  CoreConfig
> {
  constructor(checker: HyperlaneCoreChecker, owners: ChainMap<types.Address>) {
    super(checker, owners);
  }

  protected async mapViolationsToCalls() {
    for (const violation of this.checker.violations) {
      switch (violation.type) {
        case CoreViolationType.MultisigIsm: {
          this.handleMultisigIsmViolation(violation as MultisigIsmViolation);
          break;
        }
        case ViolationType.Owner: {
          this.handleOwnerViolation(violation as OwnerViolation);
          break;
        }
        case ProxyKind.Transparent: {
          await this.handleProxyViolation(violation as ProxyViolation);
          break;
        }
        default:
          throw new Error(`Unsupported violation type ${violation.type}`);
      }
    }
  }

  // pushes calls which reconcile actual and expected sets on chain
  protected pushSetReconcilationCalls<T>(reconcile: {
    chain: ChainName;
    actual: Set<T>;
    expected: Set<T>;
    add: (elem: T) => AnnotatedCallData;
    remove: (elem: T) => AnnotatedCallData;
  }) {
    // add expected - actual elements
    utils
      .difference(reconcile.expected, reconcile.actual)
      .forEach((elem) => this.pushCall(reconcile.chain, reconcile.add(elem)));

    // remote actual - expected elements
    utils
      .difference(reconcile.actual, reconcile.expected)
      .forEach((elem) =>
        this.pushCall(reconcile.chain, reconcile.remove(elem)),
      );
  }

  handleMultisigIsmViolation(violation: MultisigIsmViolation) {
    const multisigIsm = violation.contract;
    const remoteDomainId = this.checker.multiProvider.getDomainId(
      violation.remote,
    );
    switch (violation.subType) {
      case MultisigIsmViolationType.EnrolledValidators: {
        const baseDescription = `as ${violation.remote} validator on ${violation.chain}`;
        this.pushSetReconcilationCalls({
          ...(violation as EnrolledValidatorsViolation),
          add: (validator) => ({
            to: multisigIsm.address,
            data: multisigIsm.interface.encodeFunctionData('enrollValidator', [
              remoteDomainId,
              validator,
            ]),
            description: `Enroll ${validator} ${baseDescription}`,
          }),
          remove: (validator) => ({
            to: multisigIsm.address,
            data: multisigIsm.interface.encodeFunctionData(
              'unenrollValidator',
              [remoteDomainId, validator],
            ),
            description: `Unenroll ${validator} ${baseDescription}`,
          }),
        });
        break;
      }
      case MultisigIsmViolationType.Threshold: {
        this.pushCall(violation.chain, {
          to: multisigIsm.address,
          data: multisigIsm.interface.encodeFunctionData('setThreshold', [
            remoteDomainId,
            violation.expected,
          ]),
          description: `Set threshold to ${violation.expected} for ${violation.remote} on ${violation.chain}`,
        });
        break;
      }
      default:
        throw new Error(
          `Unsupported multisig module violation subtype ${violation.subType}`,
        );
    }
  }
}
