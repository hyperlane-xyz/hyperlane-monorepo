import { prompts } from 'prompts';

import { InterchainGasPaymaster, OverheadIgp } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  CoreContracts,
  CoreViolationType,
  DefaultIsmIgpViolation,
  DefaultIsmIgpViolationType,
  EnrolledValidatorsViolation,
  HyperlaneCoreChecker,
  IgpBeneficiaryViolation,
  IgpGasOraclesViolation,
  IgpViolation,
  IgpViolationType,
  MultisigIsmViolation,
  MultisigIsmViolationType,
  OwnerViolation,
  ProxyViolation,
  ViolationType,
  objMap,
} from '@hyperlane-xyz/sdk';
import { ProxyKind } from '@hyperlane-xyz/sdk/dist/proxy';
import { types, utils } from '@hyperlane-xyz/utils';

import { canProposeSafeTransactions } from '../utils/safe';

import {
  ManualMultiSend,
  MultiSend,
  SafeMultiSend,
  SignerMultiSend,
} from './multisend';

enum SubmissionType {
  MANUAL = 'MANUAL',
  SIGNER = 'SIGNER',
  SAFE = 'SAFE',
}

type AnnotatedCallData = types.CallData & {
  submissionType?: SubmissionType;
  description: string;
};

export class HyperlaneCoreGovernor {
  readonly checker: HyperlaneCoreChecker;
  private calls: ChainMap<AnnotatedCallData[]>;
  private canPropose: ChainMap<Map<string, boolean>>;

  constructor(checker: HyperlaneCoreChecker) {
    this.checker = checker;
    this.calls = objMap(this.checker.app.contractsMap, () => []);
    this.canPropose = objMap(this.checker.app.contractsMap, () => new Map());
  }

  async govern() {
    // 1. Produce calls from checker violations.
    await this.mapViolationsToCalls();

    // 2. For each call, infer how it should be submitted on-chain.
    await this.inferCallSubmissionTypes();

    // 3. Prompt the user to confirm that the count, description,
    // and submission methods look correct before submitting.
    for (const chain of Object.keys(this.calls)) {
      await this.sendCalls(chain);
    }
  }

  protected async sendCalls(chain: ChainName) {
    const calls = this.calls[chain];
    console.log(`\nFound ${calls.length} transactions for ${chain}`);
    const filterCalls = (submissionType: SubmissionType) =>
      calls.filter((call) => call.submissionType == submissionType);
    const summarizeCalls = async (
      submissionType: SubmissionType,
      calls: AnnotatedCallData[],
    ): Promise<boolean> => {
      if (calls.length > 0) {
        console.log(
          `> ${calls.length} calls will be submitted via ${submissionType}`,
        );
        calls.map((c) =>
          console.log(`> > ${c.description} (to: ${c.to} data: ${c.data})`),
        );
        const response = prompts.confirm({
          type: 'confirm',
          name: 'value',
          message: 'Can you confirm?',
          initial: false,
        });
        return response as unknown as boolean;
      }
      return false;
    };

    const sendCallsForType = async (
      submissionType: SubmissionType,
      multiSend: MultiSend,
    ) => {
      const calls = filterCalls(submissionType);
      if (calls.length > 0) {
        const confirmed = await summarizeCalls(submissionType, calls);
        if (confirmed) {
          console.log(`Submitting calls on ${chain} via ${submissionType}`);
          await multiSend.sendTransactions(
            calls.map((call) => ({ to: call.to, data: call.data })),
          );
        } else {
          console.log(
            `Skipping submission of calls on ${chain} via ${submissionType}`,
          );
        }
      }
    };

    await sendCallsForType(
      SubmissionType.SIGNER,
      new SignerMultiSend(this.checker.multiProvider, chain),
    );
    const owner = this.checker.configMap[chain!].owner!;
    await sendCallsForType(
      SubmissionType.SAFE,
      new SafeMultiSend(this.checker.multiProvider, chain, owner),
    );
    await sendCallsForType(SubmissionType.MANUAL, new ManualMultiSend(chain));
  }

  protected pushCall(chain: ChainName, call: AnnotatedCallData) {
    this.calls[chain].push(call);
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
        case CoreViolationType.InterchainGasPaymaster: {
          this.handleIgpViolation(violation as IgpViolation);
          break;
        }
        case CoreViolationType.DefaultIsmInterchainGasPaymaster: {
          this.handleDefaultIsmIgpViolation(
            violation as DefaultIsmIgpViolation,
          );
          break;
        }
        default:
          throw new Error(`Unsupported violation type ${violation.type}`);
      }
    }
  }

  handleProxyViolation(violation: ProxyViolation) {
    const contracts: CoreContracts =
      this.checker.app.contractsMap[violation.chain];
    const data = contracts.proxyAdmin.interface.encodeFunctionData('upgrade', [
      violation.data.proxyAddresses.proxy,
      violation.data.proxyAddresses.implementation,
    ]);

    this.pushCall(violation.chain, {
      to: contracts.proxyAdmin.address,
      data,
      description: `Upgrade proxy ${violation.data.proxyAddresses.proxy} to implementation ${violation.data.proxyAddresses.implementation}`,
    });
  }

  protected async inferCallSubmissionTypes() {
    for (const chain of Object.keys(this.calls)) {
      for (const call of this.calls[chain]) {
        const submissionType = await this.inferCallSubmissionType(chain, call);
        call.submissionType = submissionType;
      }
    }
  }

  protected async inferCallSubmissionType(
    chain: ChainName,
    call: AnnotatedCallData,
  ): Promise<SubmissionType> {
    const multiProvider = this.checker.multiProvider;
    const signer = multiProvider.getSigner(chain);
    const signerAddress = await signer.getAddress();

    const canUseSubmissionType = async (
      submitterAddress: types.Address,
    ): Promise<boolean> => {
      try {
        await multiProvider.estimateGas(chain, call, submitterAddress);
        return true;
      } catch (e) {} // eslint-disable-line no-empty
      return false;
    };

    if (await canUseSubmissionType(signerAddress)) {
      return SubmissionType.SIGNER;
    }

    // 2. Check if the call will succeed via Gnosis Safe.
    const safeAddress = this.checker.configMap[chain!].owner;
    if (!safeAddress) throw new Error(`Owner address not found for ${chain}`);
    // 2a. Confirm that the signer is a Safe owner or delegate.
    // This should implicitly check whether or not the owner is a gnosis
    // safe.
    if (!this.canPropose[chain].has(safeAddress)) {
      this.canPropose[chain].set(
        safeAddress,
        await canProposeSafeTransactions(
          signerAddress,
          chain,
          multiProvider,
          safeAddress,
        ),
      );
    }

    // 2b. Check if calling from the owner/safeAddress will succeed.
    if (
      this.canPropose[chain].get(safeAddress) &&
      (await canUseSubmissionType(safeAddress))
    ) {
      return SubmissionType.SAFE;
    }

    return SubmissionType.MANUAL;
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

  handleOwnerViolation(violation: OwnerViolation) {
    this.pushCall(violation.chain, {
      to: violation.contract.address,
      data: violation.contract.interface.encodeFunctionData(
        'transferOwnership',
        [violation.expected],
      ),
      description: `Transfer ownership of ${violation.contract.address} to ${violation.expected}`,
    });
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
      default:
        throw new Error(`Unsupported IgpViolationType: ${violation.subType}`);
    }
  }

  handleDefaultIsmIgpViolation(violation: DefaultIsmIgpViolation) {
    switch (violation.subType) {
      case DefaultIsmIgpViolationType.DestinationGasOverheads: {
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
          to: violation.contract.address,
          data: violation.contract.interface.encodeFunctionData(
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
          `Unsupported DefaultIsmIgpViolationType: ${violation.subType}`,
        );
    }
  }
}
