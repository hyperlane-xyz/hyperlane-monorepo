import { BigNumber, ethers } from 'ethers';

import { InterchainGasPaymaster } from '@hyperlane-xyz/core';
import {
  ChainName,
  CheckerViolation,
  HyperlaneIgp,
  IgpBeneficiaryViolation,
  IgpConfig,
  IgpGasOraclesViolation,
  IgpOverheadViolation,
  IgpViolation,
  IgpViolationType,
  OwnerViolation,
} from '@hyperlane-xyz/sdk';

import { HyperlaneAppGovernor } from '../govern/HyperlaneAppGovernor.js';

export class HyperlaneIgpGovernor extends HyperlaneAppGovernor<
  HyperlaneIgp,
  IgpConfig
> {
  protected async mapViolationToCall(violation: CheckerViolation) {
    switch (violation.type) {
      case 'InterchainGasPaymaster': {
        return this.handleIgpViolation(violation as IgpViolation);
      }
      case 'Owner': {
        return super.handleOwnerViolation(violation as OwnerViolation);
      }
      default:
        throw new Error(
          `Unsupported violation type ${violation.type}: ${JSON.stringify(
            violation,
          )}`,
        );
    }
  }

  handleIgpViolation(violation: IgpViolation) {
    switch (violation.subType) {
      case IgpViolationType.Beneficiary: {
        const beneficiaryViolation = violation as IgpBeneficiaryViolation;
        return {
          chain: beneficiaryViolation.chain,
          call: {
            to: beneficiaryViolation.contract.address,
            data: beneficiaryViolation.contract.interface.encodeFunctionData(
              'setBeneficiary',
              [beneficiaryViolation.expected],
            ),
            value: BigNumber.from(0),
            description: `Set IGP beneficiary to ${beneficiaryViolation.expected}`,
          },
        };
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

        return {
          chain: gasOraclesViolation.chain,
          call: {
            to: gasOraclesViolation.contract.address,
            data: gasOraclesViolation.contract.interface.encodeFunctionData(
              'setDestinationGasConfigs',
              [configs],
            ),
            value: BigNumber.from(0),
            description: `Setting ${Object.keys(gasOraclesViolation.expected)
              .map((remoteStr) => {
                const remote = remoteStr as ChainName;
                const remoteId = this.checker.multiProvider.getDomainId(remote);
                const expected = gasOraclesViolation.expected[remote];
                return `gas oracle for ${remote} (domain ID ${remoteId}) to ${expected}`;
              })
              .join(', ')}`,
          },
        };
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

        return {
          chain: violation.chain,
          call: {
            to: overheadViolation.contract.address,
            data: overheadViolation.contract.interface.encodeFunctionData(
              'setDestinationGasConfigs',
              [configs],
            ),
            value: BigNumber.from(0),
            description: `Setting ${Object.keys(violation.expected)
              .map((remoteStr) => {
                const remote = remoteStr as ChainName;
                const remoteId = this.checker.multiProvider.getDomainId(remote);
                const expected = violation.expected[remote];
                return `destination gas overhead for ${remote} (domain ID ${remoteId}) to ${expected}`;
              })
              .join(', ')}`,
          },
        };
      }
      default:
        throw new Error(
          `Unsupported IgpViolation subType: ${violation.subType}`,
        );
    }
  }
}
