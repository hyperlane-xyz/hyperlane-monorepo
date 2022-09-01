import { LedgerSigner } from '@ethersproject/hardware-wallets';
// Due to TS funkiness, this needs to be imported in order for this
// code to build, but needs to be removed in order for the code to run.
// import '@ethersproject/hardware-wallets/thirdparty';
import Safe from '@gnosis.pm/safe-core-sdk';
import EthersAdapter from '@gnosis.pm/safe-ethers-lib';
import { ethers } from 'ethers';

import {
  AbacusCoreChecker,
  ChainConnection,
  ChainMap,
  ChainName,
  CoreViolationType,
  OwnerViolation,
  ValidatorViolation,
  ValidatorViolationType,
  ViolationType,
  chainMetadata,
  objMap,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { ManualMultiSend, SafeMultiSend, SignerMultiSend } from './multisend';

enum SubmissionType {
  MANUAL = 'MANUAL',
  SIGNER = 'SIGNER',
  SAFE = 'SAFE',
}

type AnnotatedCallData = {
  call: types.CallData;
  submissionType?: SubmissionType;
  description: string;
};

export class AbacusCoreGovernor<Chain extends ChainName> {
  readonly checker: AbacusCoreChecker<Chain>;
  private calls: ChainMap<Chain, AnnotatedCallData[]>;
  readonly ledger: boolean;

  constructor(checker: AbacusCoreChecker<Chain>, ledger: boolean = false) {
    this.checker = checker;
    this.calls = objMap(this.checker.app.contractsMap, () => []);
    this.ledger = ledger;
  }

  async govern() {
    // 1. Produce calls from checker violations.
    await this.mapViolationsToCalls();

    // 2. For each call, infer how it should be submitted on-chain.
    await this.inferCallSubmissionTypes();

    // 3. Prompt the user to confirm that the count, description,
    // and submission methods look correct before submitting.
    for (const chain of Object.keys(this.calls) as Chain[]) {
      this.signAndSubmitCalls(chain);
    }
  }

  protected getConnection(chain: Chain) {
    const connection = this.checker.multiProvider.getChainConnection(chain);
    if (this.ledger) {
      const path = "m/44'/60'/2'/0/0";
      return new ChainConnection({
        signer: new LedgerSigner(connection.provider, 'hid', path),
        provider: connection.provider,
        overrides: connection.overrides,
        confirmations: connection.confirmations,
      });
    } else {
      return connection;
    }
  }

  protected async signAndSubmitCalls(chain: Chain) {
    const calls = this.calls[chain];
    console.log(`Found ${calls.length} transactions for ${chain}`);
    const filterCalls = (submissionType: SubmissionType) =>
      calls.filter((call) => call.submissionType == submissionType);
    const extractCalls = (calls: AnnotatedCallData[]) =>
      calls.map((c) => c.call);
    const summarizeCalls = async (
      submissionType: SubmissionType,
      calls: AnnotatedCallData[],
    ) => {
      if (calls.length > 0) {
        console.log(
          `> ${calls.length} calls will be submitted via ${submissionType}`,
        );
        calls.map((c) => console.log(`> > ${c.description}`));
        // prompt here
      }
    };

    const connection = this.getConnection(chain);

    const signerCalls = filterCalls(SubmissionType.SIGNER);
    if (signerCalls.length > 0) {
      const signerMultiSend = new SignerMultiSend(connection);
      summarizeCalls(SubmissionType.SIGNER, signerCalls);
      await signerMultiSend.sendTransactions(extractCalls(signerCalls));
    }

    const safeCalls = filterCalls(SubmissionType.SAFE);
    if (safeCalls.length > 0) {
      const owner = this.checker.configMap[chain!].owner!;
      const safeMultiSend = new SafeMultiSend(connection, chain, owner);
      summarizeCalls(SubmissionType.SAFE, safeCalls);
      await safeMultiSend.sendTransactions(extractCalls(safeCalls));
    }

    const manualCalls = filterCalls(SubmissionType.MANUAL);
    if (manualCalls.length > 0) {
      const manualMultiSend = new ManualMultiSend();
      summarizeCalls(SubmissionType.MANUAL, manualCalls);
      await manualMultiSend.sendTransactions(extractCalls(manualCalls));
    }
  }

  protected pushCall(chain: Chain, call: AnnotatedCallData) {
    this.calls[chain].push(call);
  }

  protected async mapViolationsToCalls() {
    for (const violation of this.checker.violations) {
      switch (violation.type) {
        case CoreViolationType.Validator: {
          await this.handleValidatorViolation(violation as ValidatorViolation);
          break;
        }
        case ViolationType.Owner: {
          await this.handleOwnerViolation(violation as OwnerViolation);
          break;
        }
        default:
          throw new Error(`Unsupported violation type ${violation.type}`);
      }
    }
  }

  protected async inferCallSubmissionTypes() {
    for (const chain of Object.keys(this.calls) as Chain[]) {
      const connection = this.getConnection(chain);
      for (const call of this.calls[chain]) {
        const submissionType = await this.inferCallSubmissionType(
          chain,
          connection,
          call,
        );
        call.submissionType = submissionType;
      }
    }
  }

  protected async inferCallSubmissionType(
    chain: Chain,
    connection: ChainConnection,
    call: AnnotatedCallData,
  ): Promise<SubmissionType> {
    // 1. Check if the call will succeed with the default signer.
    try {
      await connection.estimateGas(call.call);
      return SubmissionType.SIGNER;
    } catch (_) {}

    // 2. Check if the call will succeed via Gnosis Safe.
    try {
      // 2a. Estimate gas as the owner, which we infer to be a Safe.
      const safeAddress = this.checker.configMap[chain!].owner;
      if (!safeAddress) throw new Error(`Safe address not found for ${chain}`);
      await connection.provider.estimateGas({
        ...call.call,
        from: safeAddress,
      });

      // 2b. Confirm that the signer is a Safe owner.
      const signer = connection.signer;
      if (!signer) throw new Error(`no signer found`);
      const signerAddress = await signer.getAddress();
      const ethAdapter = new EthersAdapter({ ethers, signer });
      const safe = await Safe.create({ ethAdapter, safeAddress });
      const owners = await safe.getOwners();
      if (!owners.includes(signerAddress)) {
        throw new Error(
          `${signerAddress} is not an owner for Safe ${safeAddress}`,
        );
      }

      // 2c. Confirm that we have a corresponding transaction service URL
      const txServiceUrl = chainMetadata[chain].gnosisSafeTransactionServiceUrl;
      if (!txServiceUrl) {
        throw new Error(`No Safe tx service for ${chain}`);
      }

      return SubmissionType.SAFE;
    } catch (_) {}

    return SubmissionType.MANUAL;
  }

  async handleValidatorViolation(violation: ValidatorViolation) {
    const validatorManager = violation.data.validatorManager;
    const chain = violation.chain as Chain;
    switch (violation.data.type) {
      case ValidatorViolationType.EnrollValidator: {
        const call = await validatorManager.populateTransaction.enrollValidator(
          violation.expected,
        );
        this.pushCall(chain, {
          call: call as types.CallData,
          description: `Enroll ${violation.expected} on ${chain}`,
        });
        break;
      }
      case ValidatorViolationType.UnenrollValidator: {
        const call =
          await validatorManager.populateTransaction.unenrollValidator(
            violation.actual,
          );
        this.pushCall(chain, {
          call: call as types.CallData,
          description: `Unenroll ${violation.actual} on ${chain}`,
        });
        break;
      }
      case ValidatorViolationType.Threshold: {
        const call = await validatorManager.populateTransaction.setThreshold(
          violation.expected,
        );
        this.pushCall(chain, {
          call: call as types.CallData,
          description: `Set threshold to ${violation.expected} on ${chain}`,
        });
        break;
      }
      default:
        throw new Error(
          `Unsupported validator violation type ${violation.data.type}`,
        );
    }
  }

  async handleOwnerViolation(violation: OwnerViolation) {
    const call =
      await violation.data.contract.populateTransaction.transferOwnership(
        violation.expected,
      );
    const chain = violation.chain as Chain;
    this.pushCall(chain, {
      call: call as types.CallData,
      description: `Set owner of ${violation.data.contract.address} to ${violation.expected} on ${chain}`,
    });
  }
}
