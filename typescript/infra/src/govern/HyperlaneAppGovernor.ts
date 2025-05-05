import chalk from 'chalk';
import { BigNumber } from 'ethers';
import prompts from 'prompts';

import { Ownable__factory, ProxyAdmin__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  CheckerViolation,
  HyperlaneApp,
  HyperlaneAppChecker,
  InterchainAccount,
  OwnableConfig,
  OwnerViolation,
  ProxyAdminViolation,
  canProposeSafeTransactions,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  CallData,
  bytes32ToAddress,
  eqAddress,
  objMap,
  retryAsync,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getGovernanceSafes } from '../../config/environments/mainnet3/governance/utils.js';
import { GovernanceType, determineGovernanceType } from '../governance.js';

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
  expandedDescription?: string;
  icaTargetChain?: ChainName;
  governanceType?: GovernanceType;
};

export type InferredCall = {
  type: SubmissionType;
  chain: ChainName;
  call: AnnotatedCallData;
  icaTargetChain?: ChainName;
};

export abstract class HyperlaneAppGovernor<
  App extends HyperlaneApp<any>,
  Config extends OwnableConfig,
> {
  protected readonly checker: HyperlaneAppChecker<App, Config>;
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

  async check(chainsToCheck?: ChainName[]) {
    await this.checker.check(chainsToCheck);
  }

  async checkChain(chain: ChainName) {
    await this.checker.checkChain(chain);
  }

  getCheckerViolations() {
    return this.checker.violations;
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
    const calls = this.calls[chain] || [];
    rootLogger.info(`\nFound ${calls.length} transactions for ${chain}`);
    const filterCalls = (
      submissionType: SubmissionType,
      governanceType?: GovernanceType,
    ) =>
      calls.filter(
        (call) =>
          call.submissionType == submissionType &&
          (governanceType === undefined ||
            call.governanceType == governanceType),
      );
    const summarizeCalls = async (
      submissionType: SubmissionType,
      callsForSubmissionType: AnnotatedCallData[],
    ): Promise<boolean> => {
      if (!callsForSubmissionType || callsForSubmissionType.length === 0) {
        return false;
      }

      rootLogger.info(
        `${SubmissionType[submissionType]} calls: ${callsForSubmissionType.length}`,
      );
      callsForSubmissionType.map(
        ({ icaTargetChain, description, expandedDescription, ...call }) => {
          // Print a blank line to separate calls
          rootLogger.info('');

          // Print the ICA call header if it exists
          if (icaTargetChain) {
            rootLogger.info(
              chalk.bold(
                `> INTERCHAIN ACCOUNT CALL: ${chain} -> ${icaTargetChain}`,
              ),
            );
          }

          // Print the call details
          rootLogger.info(chalk.bold(`> ${description.trimEnd()}`));
          if (expandedDescription) {
            rootLogger.info(chalk.gray(`${expandedDescription.trimEnd()}`));
          }

          rootLogger.info(chalk.gray(`to: ${call.to}`));
          rootLogger.info(chalk.gray(`data: ${call.data}`));
          rootLogger.info(chalk.gray(`value: ${call.value}`));
        },
      );
      if (!requestConfirmation) return true;

      const { value: confirmed } = await prompts({
        type: 'confirm',
        name: 'value',
        message: 'Can you confirm?',
        initial: false,
      });

      return !!confirmed;
    };

    const sendCallsForType = async (
      submissionType: SubmissionType,
      multiSend: MultiSend,
      governanceType?: GovernanceType,
    ) => {
      const callsForSubmissionType = [];
      const filteredCalls = filterCalls(submissionType, governanceType);

      // Add the filtered calls to the calls for submission type
      callsForSubmissionType.push(...filteredCalls);

      if (callsForSubmissionType.length > 0) {
        this.printSeparator();
        const confirmed = await summarizeCalls(
          submissionType,
          callsForSubmissionType,
        );
        if (confirmed) {
          rootLogger.info(
            chalk.italic(
              `Submitting calls on ${chain} via ${SubmissionType[submissionType]}`,
            ),
          );
          try {
            await multiSend.sendTransactions(
              callsForSubmissionType.map((call) => ({
                to: call.to,
                data: call.data,
                value: call.value,
              })),
            );
          } catch (error) {
            rootLogger.error(
              chalk.red(`Error submitting calls on ${chain}: ${error}`),
            );
          }
        } else {
          rootLogger.info(
            chalk.italic(
              `Skipping submission of calls on ${chain} via ${SubmissionType[submissionType]}`,
            ),
          );
        }
      }
    };

    // Do all SIGNER calls first
    await sendCallsForType(
      SubmissionType.SIGNER,
      new SignerMultiSend(this.checker.multiProvider, chain),
    );

    // Then propose transactions on safes for all governance types
    for (const governanceType of Object.values(GovernanceType)) {
      const safeOwner = getGovernanceSafes(governanceType)[chain];
      if (safeOwner) {
        await retryAsync(
          () =>
            sendCallsForType(
              SubmissionType.SAFE,
              new SafeMultiSend(this.checker.multiProvider, chain, safeOwner),
              governanceType,
            ),
          10,
        );
      }
    }

    // Then finally submit remaining calls manually
    await sendCallsForType(SubmissionType.MANUAL, new ManualMultiSend(chain));

    this.printSeparator();
  }

  private printSeparator() {
    rootLogger.info(
      `-------------------------------------------------------------------------------------------------------------------`,
    );
  }

  protected pushCall(chain: ChainName, call: AnnotatedCallData) {
    this.calls[chain] = this.calls[chain] || [];
    const isDuplicate = this.calls[chain].some(
      (existingCall) =>
        existingCall.to === call.to &&
        existingCall.data === call.data &&
        existingCall.value?.eq(call.value || 0),
    );
    if (!isDuplicate) {
      this.calls[chain].push(call);
    }
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
        icaTargetChain: inferredCall.icaTargetChain,
        ...inferredCall.call,
      });
    };

    const results: ChainMap<InferredCall[]> = {};
    await Promise.all(
      Object.keys(this.calls).map(async (chain) => {
        try {
          results[chain] = await Promise.all(
            this.calls[chain].map((call) =>
              this.inferCallSubmissionType(chain, call),
            ),
          );
        } catch (error) {
          rootLogger.error(
            chalk.red(
              `Error inferring call submission types for chain ${chain}: ${error}`,
            ),
          );
          results[chain] = [];
        }
      }),
    );

    Object.entries(results).forEach(([_, inferredCalls]) => {
      inferredCalls.forEach(pushNewCall);
    });

    this.calls = newCalls;
  }

  /**
   * Infers the submission type for a call that may be encoded for an Interchain Account (ICA).
   *
   * This function performs the following steps:
   * 1. Checks if an ICA exists. If not, defaults to manual submission.
   * 2. Retrieves the owner of the target contract.
   * 3. Verifies if the owner is the ICA router. If not, defaults to manual submission.
   * 4. Fetches the ICA configuration to determine the origin chain.
   * 5. Prepares the call for remote execution via the ICA if all conditions are met.
   *
   * @param chain The chain where the call is to be executed
   * @param call The call data to be executed
   * @returns An InferredCall object with the appropriate submission type and details
   */
  protected async inferICAEncodedSubmissionType(
    chain: ChainName,
    call: AnnotatedCallData,
  ): Promise<InferredCall> {
    const multiProvider = this.checker.multiProvider;
    const signer = multiProvider.getSigner(chain);

    // If there is no ICA, default to manual submission
    if (!this.interchainAccount) {
      return {
        type: SubmissionType.MANUAL,
        chain,
        call,
      };
    }

    // Get the account's owner
    const ownableAddress = call.to;
    const ownable = Ownable__factory.connect(ownableAddress, signer);
    const account = Ownable__factory.connect(await ownable.owner(), signer);
    const localOwner = await account.owner();

    // If the account's owner is not the ICA router, default to manual submission
    if (!eqAddress(localOwner, this.interchainAccount.routerAddress(chain))) {
      rootLogger.info(
        chalk.gray(
          `Account's owner ${localOwner} is not ICA router. Defaulting to manual submission.`,
        ),
      );
      return {
        type: SubmissionType.MANUAL,
        chain,
        call,
      };
    }

    // Get the account's config
    const accountConfig = await this.interchainAccount.getAccountConfig(
      chain,
      account.address,
    );
    const origin = this.interchainAccount.multiProvider.getChainName(
      accountConfig.origin,
    );
    rootLogger.info(
      chalk.gray(
        `Inferred call for ICA remote owner ${bytes32ToAddress(
          accountConfig.owner,
        )} on ${origin} to ${chain}`,
      ),
    );

    // Get the encoded call to the remote ICA
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

    // If the call to the remote ICA is not valid, default to manual submission
    if (!callRemote.to || !callRemote.data) {
      return {
        type: SubmissionType.MANUAL,
        chain,
        call,
      };
    }

    const { governanceType } = await determineGovernanceType(
      origin,
      accountConfig.owner,
    );

    // If the call to the remote ICA is valid, infer the submission type
    const { description, expandedDescription } = call;
    const encodedCall: AnnotatedCallData = {
      to: callRemote.to,
      data: callRemote.data,
      value: callRemote.value,
      description,
      expandedDescription,
      governanceType,
    };

    // Try to infer the submission type for the ICA call
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
      true, // Flag this as an ICA call
    );

    // If returned submission type is not MANUAL
    // we'll return the inferred call with the ICA target chain
    if (subType !== SubmissionType.MANUAL) {
      return {
        type: subType,
        chain: origin,
        call: encodedCall,
        icaTargetChain: chain,
      };
    }

    // Else, default to manual submission
    return {
      type: SubmissionType.MANUAL,
      chain,
      call,
    };
  }

  /**
   * Infers the submission type for a call.
   *
   * This function performs the following steps:
   * 1. Checks if the transaction will succeed with the SIGNER.
   * 2. Checks if the transaction will succeed with a SAFE.
   * 3. If not already an ICA call, tries to infer an ICA call.
   * 4. If the transaction will not succeed with SIGNER, SAFE, or ICA, defaults to MANUAL submission.
   *
   * @param chain The chain where the call is to be executed
   * @param call The call data to be executed
   * @param additionalTxSuccessCriteria An optional function to check additional success criteria for the transaction
   * @param isICACall Flag to indicate if the call is already an ICA call
   * @returns An InferredCall object with the appropriate submission type and details
   */
  protected async inferCallSubmissionType(
    chain: ChainName,
    call: AnnotatedCallData,
    additionalTxSuccessCriteria?: (
      chain: ChainName,
      submitterAddress: Address,
    ) => boolean,
    isICACall: boolean = false,
  ): Promise<InferredCall> {
    const multiProvider = this.checker.multiProvider;
    const signer = multiProvider.getSigner(chain);
    const signerAddress = await signer.getAddress();

    // Check if the transaction will succeed with a given submitter address
    const checkTransactionSuccess = async (
      chain: ChainName,
      submitterAddress: Address,
    ): Promise<boolean> => {
      // Check if the transaction has a value and if the submitter has enough balance
      if (call.value !== undefined) {
        await this.checkSubmitterBalance(chain, submitterAddress, call.value);
      }

      // Check if the submitter is the owner of the contract
      try {
        const ownable = Ownable__factory.connect(call.to, signer);
        const owner = await ownable.owner();
        const isOwner = eqAddress(owner, submitterAddress);

        if (!isOwner) {
          return false;
        }
      } catch {
        // If the contract does not implement Ownable, just continue
        // with the next check.
      }

      // Check if the transaction has additional success criteria
      if (
        additionalTxSuccessCriteria &&
        !additionalTxSuccessCriteria(chain, submitterAddress)
      ) {
        return false;
      }

      // Check if the transaction will succeed with the signer
      try {
        await multiProvider.estimateGas(chain, call, submitterAddress);
        return true;
      } catch (_) {
        return false;
      }
    };

    // Check if the transaction will succeed with the SIGNER
    if (await checkTransactionSuccess(chain, signerAddress)) {
      return {
        type: SubmissionType.SIGNER,
        chain,
        call,
      };
    }

    // Check if the transaction will succeed with a SAFE
    // Need to check all governance types because the safe address is different for each type
    for (const governanceType of Object.values(GovernanceType)) {
      const safeAddress = getGovernanceSafes(governanceType)[chain];
      if (typeof safeAddress === 'string') {
        // Check if the safe can propose transactions
        const canProposeSafe = await this.checkSafeProposalEligibility(
          chain,
          signerAddress,
          safeAddress,
        );
        if (
          canProposeSafe &&
          (await checkTransactionSuccess(chain, safeAddress))
        ) {
          call.governanceType = governanceType;
          // If the transaction will succeed with the safe, return the inferred call
          return { type: SubmissionType.SAFE, chain, call };
        }
      }
    }

    // If we're not already an ICA call, try to infer an ICA call
    // We'll also infer the governance type for the ICA call
    if (!isICACall) {
      return this.inferICAEncodedSubmissionType(chain, call);
    }

    // If the transaction will not succeed with SIGNER, SAFE or ICA, default to MANUAL submission
    return {
      type: SubmissionType.MANUAL,
      chain,
      call,
    };
  }

  private async checkSubmitterBalance(
    chain: ChainName,
    submitterAddress: Address,
    requiredValue: BigNumber,
  ): Promise<void> {
    const submitterBalance = await this.checker.multiProvider
      .getProvider(chain)
      .getBalance(submitterAddress);
    if (submitterBalance.lt(requiredValue)) {
      rootLogger.warn(
        chalk.yellow(
          `Submitter ${submitterAddress} has an insufficient balance for the call and is likely to fail. Balance: ${submitterBalance}, Balance required: ${requiredValue}`,
        ),
      );
    }
  }

  private async checkSafeProposalEligibility(
    chain: ChainName,
    signerAddress: Address,
    safeAddress: string,
    retries = 10,
  ): Promise<boolean> {
    if (!this.canPropose[chain].has(safeAddress)) {
      try {
        const canPropose = await canProposeSafeTransactions(
          signerAddress,
          chain,
          this.checker.multiProvider,
          safeAddress,
        );
        this.canPropose[chain].set(safeAddress, canPropose);
      } catch (error) {
        const errorMessage = (error as Error).message.toLowerCase();

        // Handle invalid MultiSend contract errors
        if (
          errorMessage.includes('invalid multisend contract address') ||
          errorMessage.includes('invalid multisendcallonly contract address')
        ) {
          rootLogger.warn(chalk.yellow(`Invalid contract: ${errorMessage}.`));
          return false;
        }

        // Handle service unavailable and rate limit errors
        if (
          errorMessage.includes('service unavailable') ||
          errorMessage.includes('too many requests')
        ) {
          rootLogger.warn(
            chalk.yellow(
              `Safe service error for ${safeAddress} on ${chain}: ${errorMessage}. ${retries} retries left.`,
            ),
          );

          if (retries > 0) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return this.checkSafeProposalEligibility(
              chain,
              signerAddress,
              safeAddress,
              retries - 1,
            );
          }
          return false;
        }

        // Handle all other errors
        rootLogger.error(
          chalk.red(
            `Failed to determine if signer can propose safe transactions on ${chain}. Error: ${error}`,
          ),
        );
        return false;
      }
    }
    return this.canPropose[chain].get(safeAddress) || false;
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

  async handleProxyAdminViolation(violation: ProxyAdminViolation) {
    const provider = this.checker.multiProvider.getProvider(violation.chain);
    const code = await provider.getCode(violation.expected);
    const proxyAdminInterface = ProxyAdmin__factory.createInterface();

    let call;
    if (code !== '0x') {
      // admin for proxy is ProxyAdmin contract
      call = {
        chain: violation.chain,
        call: {
          to: violation.actual,
          data: proxyAdminInterface.encodeFunctionData('changeProxyAdmin', [
            violation.proxyAddress,
            violation.expected,
          ]),
          value: BigNumber.from(0),
          description: `Change proxyAdmin of transparent proxy ${violation.proxyAddress} from ${violation.actual} to ${violation.expected}`,
        },
      };
    } else {
      throw new Error(
        `Admin for proxy ${violation.proxyAddress} is not a ProxyAdmin contract`,
      );
    }

    return call;
  }
}
