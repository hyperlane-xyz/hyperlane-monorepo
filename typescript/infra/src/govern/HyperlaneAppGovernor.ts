import { prompts } from 'prompts';

import {
  ChainMap,
  ChainName,
  HyperlaneApp,
  HyperlaneAppChecker,
  OwnerViolation,
  objMap,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { canProposeSafeTransactions } from '../utils/safe';

import {
  ManualMultiSend,
  MultiSend,
  SafeMultiSend,
  SignerMultiSend,
} from './multisend';

export enum SubmissionType {
  MANUAL = 'MANUAL',
  SIGNER = 'SIGNER',
  SAFE = 'SAFE',
}

export type AnnotatedCallData = types.CallData & {
  submissionType?: SubmissionType;
  description: string;
};

export abstract class HyperlaneAppGovernor<
  App extends HyperlaneApp<any>,
  Config,
> {
  readonly checker: HyperlaneAppChecker<App, Config>;
  private owners: ChainMap<types.Address>;
  private calls: ChainMap<AnnotatedCallData[]>;
  private canPropose: ChainMap<Map<string, boolean>>;

  constructor(
    checker: HyperlaneAppChecker<App, Config>,
    owners: ChainMap<types.Address>,
  ) {
    this.checker = checker;
    this.owners = owners;
    this.calls = objMap(this.checker.app.contractsMap, () => []);
    this.canPropose = objMap(this.checker.app.contractsMap, () => new Map());
  }

  async govern(confirm = true, chain?: ChainName) {
    if (this.checker.violations.length === 0) return;

    // 1. Produce calls from checker violations.
    await this.mapViolationsToCalls();

    // 2. For each call, infer how it should be submitted on-chain.
    await this.inferCallSubmissionTypes();

    // 3. Prompt the user to confirm that the count, description,
    // and submission methods look correct before submitting.
    const chains = chain ? [chain] : Object.keys(this.calls);
    for (const chain of chains) {
      await this.sendCalls(chain, confirm);
    }
  }

  protected async sendCalls(chain: ChainName, confirm: boolean) {
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
        const response =
          !confirm ||
          (await prompts.confirm({
            type: 'confirm',
            name: 'value',
            message: 'Can you confirm?',
            initial: false,
          }));
        return !!response;
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
    await sendCallsForType(
      SubmissionType.SAFE,
      new SafeMultiSend(this.checker.multiProvider, chain, this.owners[chain]),
    );
    await sendCallsForType(SubmissionType.MANUAL, new ManualMultiSend(chain));
  }

  protected pushCall(chain: ChainName, call: AnnotatedCallData) {
    this.calls[chain].push(call);
  }

  protected abstract mapViolationsToCalls(): Promise<void>;

  protected async inferCallSubmissionTypes() {
    for (const chain of Object.keys(this.calls)) {
      for (const call of this.calls[chain]) {
        call.submissionType = await this.inferCallSubmissionType(chain, call);
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

    const transactionSucceedsFromSender = async (
      submitterAddress: types.Address,
    ): Promise<boolean> => {
      try {
        await multiProvider.estimateGas(chain, call, submitterAddress);
        return true;
      } catch (e) {} // eslint-disable-line no-empty
      return false;
    };

    if (await transactionSucceedsFromSender(signerAddress)) {
      return SubmissionType.SIGNER;
    }

    // 2. Check if the call will succeed via Gnosis Safe.
    const safeAddress = this.owners[chain];
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
      (this.canPropose[chain].get(safeAddress) &&
        (await transactionSucceedsFromSender(safeAddress))) ||
      chain === 'moonbeam'
    ) {
      return SubmissionType.SAFE;
    }

    return SubmissionType.MANUAL;
  }

  handleOwnerViolation(violation: OwnerViolation) {
    this.pushCall(violation.chain, {
      to: violation.contract.address,
      data: violation.contract.interface.encodeFunctionData(
        'transferOwnership',
        [violation.expected],
      ),
      description: `Transfer ownership of ${violation.name} at ${violation.contract.address} to ${violation.expected}`,
    });
  }
}
