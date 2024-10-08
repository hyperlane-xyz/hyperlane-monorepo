import { BigNumber } from 'ethers';
import prompts from 'prompts';

import { Ownable__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  CheckerViolation,
  HyperlaneApp,
  HyperlaneAppChecker,
  InterchainAccount,
  OwnableConfig,
  OwnerViolation,
} from '@hyperlane-xyz/sdk';
// @ts-ignore
import { canProposeSafeTransactions } from '@hyperlane-xyz/sdk';
import {
  Address,
  CallData,
  bytes32ToAddress,
  eqAddress,
  objMap,
  retryAsync,
} from '@hyperlane-xyz/utils';

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

export type InferredCall = {
  type: SubmissionType;
  chain: ChainName;
  call: AnnotatedCallData;
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

  protected async sendCalls(chain: ChainName, requestConfirmation: boolean) {
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
          `> ${calls.length} calls will be submitted via ${SubmissionType[submissionType]}`,
        );
        calls.map((c) =>
          console.log(`> > ${c.description} (to: ${c.to} data: ${c.data})`),
        );
        if (!requestConfirmation) return true;

        const { value: confirmed } = await prompts({
          type: 'confirm',
          name: 'value',
          message: 'Can you confirm?',
          initial: false,
        });

        return !!confirmed;
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
          console.log(
            `Submitting calls on ${chain} via ${SubmissionType[submissionType]}`,
          );
          try {
            await multiSend.sendTransactions(
              calls.map((call) => ({
                to: call.to,
                data: call.data,
                value: call.value,
              })),
            );
          } catch (error) {
            console.error(`Error submitting calls on ${chain}: ${error}`);
          }
        } else {
          console.log(
            `Skipping submission of calls on ${chain} via ${SubmissionType[submissionType]}`,
          );
        }
      }
    };

    await sendCallsForType(
      SubmissionType.SIGNER,
      new SignerMultiSend(this.checker.multiProvider, chain),
    );

    const safeOwner = this.checker.configMap[chain].owner;
    await retryAsync(
      () =>
        sendCallsForType(
          SubmissionType.SAFE,
          new SafeMultiSend(this.checker.multiProvider, chain, safeOwner),
        ),
      10,
    );

    await sendCallsForType(SubmissionType.MANUAL, new ManualMultiSend(chain));
  }

  protected pushCall(chain: ChainName, call: AnnotatedCallData) {
    this.calls[chain] = this.calls[chain] || [];
    this.calls[chain].push(call);
  }

  protected async mapViolationsToCalls(): Promise<void> {
    const callObjs = await Promise.all(
      this.checker.violations.map((violation) =>
        this.mapViolationToCall(violation),
      ),
    );

    for (const callObj of callObjs) {
      if (callObj) {
        this.pushCall(callObj.chain, callObj.call);
      }
    }
  }

  protected abstract mapViolationToCall(
    violation: CheckerViolation,
  ): Promise<{ chain: string; call: AnnotatedCallData } | undefined>;

  protected async inferCallSubmissionTypes() {
    const newCalls: ChainMap<AnnotatedCallData[]> = {};

    const pushNewCall = (inferredCall: InferredCall) => {
      newCalls[inferredCall.chain] = newCalls[inferredCall.chain] || [];
      newCalls[inferredCall.chain].push({
        submissionType: inferredCall.type,
        ...inferredCall.call,
      });
    };

    for (const chain of Object.keys(this.calls)) {
      try {
        for (const call of this.calls[chain]) {
          let inferredCall: InferredCall;

          inferredCall = await this.inferCallSubmissionType(chain, call);
          // If it's a manual call, it means that we're not able to make the call
          // from a signer or Safe. In this case, we try to infer if it must be sent
          // from an ICA controlled by a remote owner. This new inferred call will be
          // unchanged if the call is not an ICA call after all.
          if (inferredCall.type === SubmissionType.MANUAL) {
            inferredCall = await this.inferICAEncodedSubmissionType(
              chain,
              call,
            );
          }
          pushNewCall(inferredCall);
        }
      } catch (error) {
        console.error(
          `Error inferring call submission types for chain ${chain}: ${error}`,
        );
      }
    }

    this.calls = newCalls;
  }

  protected async inferICAEncodedSubmissionType(
    chain: ChainName,
    call: AnnotatedCallData,
  ): Promise<InferredCall> {
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
        const callRemote = await this.interchainAccount.getCallRemote({
          chain: origin,
          destination: chain,
          innerCalls: [
            {
              to: call.to,
              data: call.data,
              value: call.value?.toString() || '0',
            },
          ],
          config: accountConfig,
        });
        if (!callRemote.to || !callRemote.data) {
          return {
            type: SubmissionType.MANUAL,
            chain,
            call,
          };
        }
        const encodedCall: AnnotatedCallData = {
          to: callRemote.to,
          data: callRemote.data,
          value: callRemote.value,
          description: `${call.description} - interchain account call from ${origin} to ${chain}`,
        };
        const { type: subType } = await this.inferCallSubmissionType(
          origin,
          encodedCall,
          (chain: ChainName, submitterAddress: Address) => {
            // Require the submitter to be the owner of the ICA on the origin chain.
            return (
              chain === origin &&
              eqAddress(bytes32ToAddress(accountConfig.owner), submitterAddress)
            );
          },
        );
        if (subType !== SubmissionType.MANUAL) {
          return {
            type: subType,
            chain: origin,
            call: encodedCall,
          };
        }
      } else {
        console.log(`Account's owner ${localOwner} is not ICA router`);
      }
    }
    return {
      type: SubmissionType.MANUAL,
      chain,
      call,
    };
  }

  protected async inferCallSubmissionType(
    chain: ChainName,
    call: AnnotatedCallData,
    additionalTxSuccessCriteria?: (
      chain: ChainName,
      submitterAddress: Address,
    ) => boolean,
  ): Promise<InferredCall> {
    const multiProvider = this.checker.multiProvider;
    const signer = multiProvider.getSigner(chain);
    const signerAddress = await signer.getAddress();

    const transactionSucceedsFromSender = async (
      chain: ChainName,
      submitterAddress: Address,
    ): Promise<boolean> => {
      // The submitter needs to have enough balance to pay for the call.
      // Surface a warning if the submitter's balance is insufficient, as this
      // can result in fooling the tooling into thinking otherwise valid submission
      // types are invalid.
      if (call.value !== undefined) {
        const submitterBalance = await multiProvider
          .getProvider(chain)
          .getBalance(submitterAddress);
        if (submitterBalance.lt(call.value)) {
          console.warn(
            `Submitter ${submitterAddress} has an insufficient balance for the call and is likely to fail. Balance:`,
            submitterBalance,
            'Balance required:',
            call.value,
          );
        }
      }

      try {
        if (
          additionalTxSuccessCriteria &&
          !additionalTxSuccessCriteria(chain, submitterAddress)
        ) {
          return false;
        }
        // Will throw if the transaction fails
        await multiProvider.estimateGas(chain, call, submitterAddress);
        return true;
      } catch (e) {} // eslint-disable-line no-empty
      return false;
    };

    if (await transactionSucceedsFromSender(chain, signerAddress)) {
      return {
        type: SubmissionType.SIGNER,
        chain,
        call,
      };
    }

    // 2. Check if the call will succeed via Gnosis Safe.
    const safeAddress = this.checker.configMap[chain].owner;

    if (typeof safeAddress === 'string') {
      // 2a. Confirm that the signer is a Safe owner or delegate.
      // This should implicitly check whether or not the owner is a gnosis
      // safe.
      if (!this.canPropose[chain].has(safeAddress)) {
        try {
          const canPropose = await canProposeSafeTransactions(
            signerAddress,
            chain,
            multiProvider,
            safeAddress,
          );
          this.canPropose[chain].set(safeAddress, canPropose);
        } catch (error) {
          // if we hit this error, it's likely a custom safe chain
          // so let's fallback to a manual submission
          if (
            error instanceof Error &&
            (error.message.includes('Invalid MultiSend contract address') ||
              error.message.includes(
                'Invalid MultiSendCallOnly contract address',
              ))
          ) {
            console.warn(`${error.message}: Setting submission type to MANUAL`);
            return {
              type: SubmissionType.MANUAL,
              chain,
              call,
            };
          } else {
            console.error(
              `Failed to determine if signer can propose safe transactions: ${error}`,
            );
          }
        }
      }

      // 2b. Check if calling from the owner/safeAddress will succeed.
      if (
        this.canPropose[chain].get(safeAddress) &&
        (await transactionSucceedsFromSender(chain, safeAddress))
      ) {
        return {
          type: SubmissionType.SAFE,
          chain,
          call,
        };
      }
    }

    return {
      type: SubmissionType.MANUAL,
      chain,
      call,
    };
  }

  handleOwnerViolation(violation: OwnerViolation) {
    return {
      chain: violation.chain,
      call: {
        to: violation.contract.address,
        data: violation.contract.interface.encodeFunctionData(
          'transferOwnership',
          [violation.expected],
        ),
        value: BigNumber.from(0),
        description: `Transfer ownership of ${violation.name} at ${violation.contract.address} to ${violation.expected}`,
      },
    };
  }
}
