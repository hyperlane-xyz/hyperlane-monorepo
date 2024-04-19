import { BigNumber } from 'ethers';
import prompts from 'prompts';

import { Ownable__factory } from '@hyperlane-xyz/core';
import {
  AccountConfig,
  ChainMap,
  ChainName,
  HyperlaneApp,
  HyperlaneAppChecker,
  InterchainAccount,
  OwnableConfig,
  OwnerViolation,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  CallData,
  bytes32ToAddress,
  eqAddress,
  objMap,
} from '@hyperlane-xyz/utils';

import { canProposeSafeTransactions } from '../utils/safe.js';

import {
  ManualMultiSend,
  MultiSend,
  SafeMultiSend,
  SignerMultiSend,
} from './multisend.js';

export enum SubmissionType {
  MANUAL = 0,
  SAFE = 1,
  SIGNER = 2,
}

export type AnnotatedCallData = CallData & {
  submissionType?: SubmissionType;
  description: string;
};

export abstract class HyperlaneAppGovernor<
  App extends HyperlaneApp<any>,
  Config extends OwnableConfig,
> {
  readonly checker: HyperlaneAppChecker<App, Config>;
  protected calls: ChainMap<AnnotatedCallData[]>;
  private canPropose: ChainMap<Map<string, boolean>>;
  readonly interchainAccount?: InterchainAccount;

  constructor(
    checker: HyperlaneAppChecker<App, Config>,
    readonly ica?: InterchainAccount,
  ) {
    this.checker = checker;
    this.calls = objMap(this.checker.app.contractsMap, () => []);
    this.canPropose = objMap(this.checker.app.contractsMap, () => new Map());
    if (ica) {
      this.interchainAccount = ica;
    }
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
          (await prompts({
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
            calls.map((call) => ({
              to: call.to,
              data: call.data,
              value: call.value,
            })),
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
    let safeOwner: Address;
    if (typeof this.checker.configMap[chain].owner === 'string') {
      safeOwner = this.checker.configMap[chain].owner as Address;
    } else {
      safeOwner = (this.checker.configMap[chain].owner as AccountConfig).owner;
    }
    await sendCallsForType(
      SubmissionType.SAFE,
      new SafeMultiSend(this.checker.multiProvider, chain, safeOwner),
    );
    await sendCallsForType(SubmissionType.MANUAL, new ManualMultiSend(chain));
  }

  protected pushCall(chain: ChainName, call: AnnotatedCallData) {
    this.calls[chain] = this.calls[chain] || [];
    this.calls[chain].push(call);
  }

  protected popCall(chain: ChainName): AnnotatedCallData | undefined {
    return this.calls[chain].pop();
  }

  protected abstract mapViolationsToCalls(): Promise<void>;

  protected async inferCallSubmissionTypes() {
    for (const chain of Object.keys(this.calls)) {
      for (const call of this.calls[chain]) {
        let submissionType = await this.inferCallSubmissionType(chain, call);
        if (submissionType === SubmissionType.MANUAL) {
          submissionType = await this.inferICAEncodedSubmissionType(
            chain,
            call,
          );
        }
        call.submissionType = submissionType;
      }
    }
  }

  protected async inferICAEncodedSubmissionType(
    chain: ChainName,
    call: AnnotatedCallData,
  ): Promise<SubmissionType> {
    const multiProvider = this.checker.multiProvider;
    const signer = multiProvider.getSigner(chain);
    if (this.interchainAccount) {
      const ownableAddress = call.to;
      const ownable = Ownable__factory.connect(ownableAddress, signer);
      const account = Ownable__factory.connect(await ownable.owner(), signer);
      const localOwner = await account.owner();
      if (eqAddress(localOwner, this.interchainAccount.routerAddress(chain))) {
        const accountConfig = await this.interchainAccount.getAccountConfig(
          chain,
          account.address,
        );
        const origin = this.interchainAccount.multiProvider.getChainName(
          accountConfig.origin,
        );
        console.log(
          `Inferred call for ICA remote owner ${bytes32ToAddress(
            accountConfig.owner,
          )} on ${origin}`,
        );
        const callRemote = await this.interchainAccount.getCallRemote(
          origin,
          chain,
          [call],
          accountConfig,
        );
        if (!callRemote.to || !callRemote.data) {
          return SubmissionType.MANUAL;
        }
        const encodedCall: AnnotatedCallData = {
          to: callRemote.to,
          data: callRemote.data,
          value: callRemote.value,
          description: `${call.description} - interchain account call from ${origin} to ${chain}`,
        };
        const subType = await this.inferCallSubmissionType(origin, encodedCall);
        if (subType !== SubmissionType.MANUAL) {
          this.popCall(chain);
          this.pushCall(origin, encodedCall);
          return subType;
        }
      } else {
        console.log(`Account's owner ${localOwner} is not ICA router`);
      }
    }
    return SubmissionType.MANUAL;
  }

  protected async inferCallSubmissionType(
    chain: ChainName,
    call: AnnotatedCallData,
  ): Promise<SubmissionType> {
    const multiProvider = this.checker.multiProvider;
    const signer = multiProvider.getSigner(chain);
    const signerAddress = await signer.getAddress();

    const transactionSucceedsFromSender = async (
      chain: ChainName,
      submitterAddress: Address,
    ): Promise<boolean> => {
      try {
        await multiProvider.estimateGas(chain, call, submitterAddress);
        return true;
      } catch (e) {} // eslint-disable-line no-empty
      return false;
    };

    if (await transactionSucceedsFromSender(chain, signerAddress)) {
      return SubmissionType.SIGNER;
    }

    // 2. Check if the call will succeed via Gnosis Safe.
    const safeAddress = this.checker.configMap[chain].owner;

    if (typeof safeAddress === 'string') {
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
        (await transactionSucceedsFromSender(chain, safeAddress))
      ) {
        return SubmissionType.SAFE;
      }
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
      value: BigNumber.from(0),
      description: `Transfer ownership of ${violation.name} at ${violation.contract.address} to ${violation.expected}`,
    });
  }
}
