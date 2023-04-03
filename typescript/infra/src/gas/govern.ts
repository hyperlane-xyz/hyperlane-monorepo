import { InterchainGasPaymaster, OverheadIgp } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  HyperlaneIgp,
  HyperlaneIgpChecker,
  IgpBeneficiaryViolation,
  IgpGasOraclesViolation,
  IgpOverheadViolation,
  IgpViolation,
  IgpViolationType,
  OverheadIgpConfig,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneAppGovernor } from '../govern/HyperlaneAppGovernor';

export class HyperlaneIgpGovernor extends HyperlaneAppGovernor<
  HyperlaneIgp,
  OverheadIgpConfig
> {
  constructor(checker: HyperlaneIgpChecker, owners: ChainMap<types.Address>) {
    super(checker, owners);
  }

  protected async mapViolationsToCalls() {
    for (const violation of this.checker.violations) {
      switch (violation.type) {
        case 'InterchainGasPaymaster': {
          this.handleIgpViolation(violation as IgpViolation);
          break;
        }
        default:
          throw new Error(`Unsupported violation type ${violation.type}`);
      }
    }
  }

  handleIgpViolation(violation: IgpViolation) {
    switch (violation.subType) {
      case IgpViolationType.Beneficiary: {
        const beneficiaryViolation = violation as IgpBeneficiaryViolation;
        this.pushCall(beneficiaryViolation.chain, {
          to: beneficiaryViolation.contract.address,
          data: beneficiaryViolation.contract.interface.encodeFunctionData(
            'setBeneficiary',
            [beneficiaryViolation.expected],
          ),
          description: `Set IGP beneficiary to ${beneficiaryViolation.expected}`,
        });
        break;
      }
      case IgpViolationType.GasOracles: {
        const gasOraclesViolation = violation as IgpGasOraclesViolation;

        const configs: InterchainGasPaymaster.GasOracleConfigStruct[] = [];
        for (const [remote, expected] of Object.entries(
          gasOraclesViolation.expected,
        )) {
          const remoteId = this.checker.multiProvider.getDomainId(remote);

          configs.push({
            remoteDomain: remoteId,
            gasOracle: expected,
          });
        }

        this.pushCall(gasOraclesViolation.chain, {
          to: gasOraclesViolation.contract.address,
          data: gasOraclesViolation.contract.interface.encodeFunctionData(
            'setGasOracles',
            [configs],
          ),
          description: `Setting ${Object.keys(gasOraclesViolation.expected)
            .map((remoteStr) => {
              const remote = remoteStr as ChainName;
              const remoteId = this.checker.multiProvider.getDomainId(remote);
              const expected = gasOraclesViolation.expected[remote];
              return `gas oracle for ${remote} (domain ID ${remoteId}) to ${expected}`;
            })
            .join(', ')}`,
        });
        break;
      }
      case IgpViolationType.Overhead: {
        const overheadViolation = violation as IgpOverheadViolation;
        const configs: OverheadIgp.DomainConfigStruct[] = Object.entries(
          violation.expected,
        ).map(
          ([remote, gasOverhead]) =>
            ({
              domain: this.checker.multiProvider.getDomainId(remote),
              gasOverhead: gasOverhead,
            } as OverheadIgp.DomainConfigStruct),
        );

        this.pushCall(violation.chain, {
          to: overheadViolation.contract.address,
          data: overheadViolation.contract.interface.encodeFunctionData(
            'setDestinationGasOverheads',
            [configs],
          ),
          description: `Setting ${Object.keys(violation.expected)
            .map((remoteStr) => {
              const remote = remoteStr as ChainName;
              const remoteId = this.checker.multiProvider.getDomainId(remote);
              const expected = violation.expected[remote];
              return `destination gas overhead for ${remote} (domain ID ${remoteId}) to ${expected}`;
            })
            .join(', ')}`,
        });
        break;
      }
      default:
        throw new Error(
          `Unsupported IgpViolation subType: ${violation.subType}`,
        );
    }
  }
}
