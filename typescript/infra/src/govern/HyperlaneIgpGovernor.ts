import { BigNumber, ethers } from 'ethers';

import { InterchainGasPaymaster } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  HyperlaneIgp,
  HyperlaneIgpChecker,
  IgpBeneficiaryViolation,
  IgpConfig,
  IgpGasOraclesViolation,
  IgpOverheadViolation,
  IgpViolation,
  IgpViolationType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneAppGovernor } from '../govern/HyperlaneAppGovernor';

export class HyperlaneIgpGovernor extends HyperlaneAppGovernor<
  HyperlaneIgp,
  IgpConfig
> {
  constructor(checker: HyperlaneIgpChecker, owners: ChainMap<Address>) {
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

        const configs: InterchainGasPaymaster.GasParamStruct[] = [];
        for (const [remote, expected] of Object.entries(
          gasOraclesViolation.expected,
        )) {
          const remoteId = this.checker.multiProvider.getDomainId(remote);

          configs.push({
            remoteDomain: remoteId,
            config: {
              gasOracle: expected,
              gasOverhead: 0, // TODO: fix to use the retrieved gas overhead
            },
          });
        }

        this.pushCall(gasOraclesViolation.chain, {
          to: gasOraclesViolation.contract.address,
          data: gasOraclesViolation.contract.interface.encodeFunctionData(
            'setDestinationGasConfigs',
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
        const configs: InterchainGasPaymaster.GasParamStruct[] = Object.entries(
          violation.expected,
        ).map(([remote, gasOverhead]) => ({
          remoteDomain: this.checker.multiProvider.getDomainId(remote),
          // TODO: fix to use the retrieved gas oracle
          config: {
            gasOracle: ethers.constants.AddressZero,
            gasOverhead: BigNumber.from(gasOverhead),
          },
        }));

        this.pushCall(violation.chain, {
          to: overheadViolation.contract.address,
          data: overheadViolation.contract.interface.encodeFunctionData(
            'setDestinationGasConfigs',
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
