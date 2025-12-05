import chalk from 'chalk';
import { BigNumber } from 'ethers';
import prompts from 'prompts';

import { Ownable__factory, ProxyAdmin__factory } from '@hyperlane-xyz/core';
import {
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  ChainTechnicalStack,
  CheckerViolation,
  EV5GnosisSafeTxBuilder,
  EV5GnosisSafeTxSubmitter,
  EV5JsonRpcTxSubmitter,
  GetCallRemoteSettings,
  HyperlaneApp,
  HyperlaneAppChecker,
  InterchainAccount,
  MultiProvider,
  OwnableConfig,
  OwnerViolation,
  ProtocolType,
  ProxyAdminViolation,
  TxSubmitterInterface,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  CallData,
  assert,
  bytes32ToAddress,
  eqAddress,
  objMap,
  retryAsync,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { awIcasLegacy } from '../../config/environments/mainnet3/governance/ica/_awLegacy.js';
import { regularIcasLegacy } from '../../config/environments/mainnet3/governance/ica/_regularLegacy.js';
import { getGovernanceSafes } from '../../config/environments/mainnet3/governance/utils.js';
import { legacyEthIcaRouter, legacyIcaChainRouters } from '../config/chain.js';
import {
  GovernanceType,
  Owner,
  determineGovernanceType,
} from '../governance.js';

export enum SubmissionType {
  MANUAL = 0,
  SAFE = 1,
  SIGNER = 2,
}

export type AnnotatedCallData = CallData & {
  submissionType?: SubmissionType;
  description: string;
  expandedDescription?: string;
  callRemoteArgs?: GetCallRemoteSettings;
  governanceType?: GovernanceType;
};

export type InferredCall = {
  type: SubmissionType;
  chain: ChainName;
  call: AnnotatedCallData;
  callRemoteArgs?: GetCallRemoteSettings;
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

  /**
   * Converts AnnotatedCallData to AnnotatedEV5Transaction format
   */
  private convertToAnnotatedEV5Transaction(
    chain: ChainName,
    call: AnnotatedCallData,
  ): AnnotatedEV5Transaction {
    const chainId = this.checker.multiProvider.getChainId(chain);
    return {
      to: call.to,
      data: call.data,
      value: call.value,
      chainId,
    };
  }

  /**
   * Creates a JSON RPC submitter for direct transaction submission
   */
  private createJsonRpcSubmitter(
    chain: ChainName,
  ): TxSubmitterInterface<ProtocolType.Ethereum> {
    return new EV5JsonRpcTxSubmitter(this.checker.multiProvider, {
      chain,
    });
  }

  /**
   * Creates a Safe submitter for a given governance type
   */
  private async createSafeSubmitter(
    chain: ChainName,
    safeAddress: Address,
  ): Promise<TxSubmitterInterface<ProtocolType.Ethereum>> {
    return await EV5GnosisSafeTxSubmitter.create(
      this.checker.multiProvider,
      {
        chain,
        safeAddress,
      },
    );
  }

  /**
   * Creates a Safe Transaction Builder for JSON fallback
   */
  private async createSafeTxBuilder(
    chain: ChainName,
    safeAddress: Address,
  ): Promise<TxSubmitterInterface<ProtocolType.Ethereum>> {
    return await EV5GnosisSafeTxBuilder.create(
      this.checker.multiProvider,
      {
        chain,
        safeAddress,
        version: '1.0',
      },
    );
  }

  /**
   * Creates a submitter for ICA calls
   * Note: ICA calls are already encoded and should be submitted to Safe on origin chain
   * The callRemoteArgs contains the origin chain information
   */
  private async createIcaSubmitter(
    originChain: ChainName,
    governanceType: GovernanceType,
  ): Promise<TxSubmitterInterface<ProtocolType.Ethereum> | null> {
    const safeAddress = getGovernanceSafes(governanceType)[originChain];
    if (!safeAddress) {
      return null;
    }

    // ICA calls are submitted via Safe on the origin chain
    // The call is already encoded for ICA execution
    try {
      return await this.createSafeSubmitter(originChain, safeAddress);
    } catch {
      return null;
    }
  }

  /**
   * Displays JSON payload for manual upload when Safe API fails
   */
  private displayFallbackJson(
    chain: ChainName,
    safeAddress: Address,
    jsonPayload: any,
  ) {
    if (!jsonPayload) {
      rootLogger.warn(
        chalk.yellow(
          `No JSON payload available for fallback. Safe API call failed and JSON generation was not successful.`,
        ),
      );
      return;
    }

    rootLogger.info(
      chalk.bold.yellow(
        `\n${'='.repeat(80)}\n` +
          `SAFE API CALL FAILED - MANUAL JSON UPLOAD REQUIRED\n` +
          `${'='.repeat(80)}\n` +
          `Chain: ${chain}\n` +
          `Safe Address: ${safeAddress}\n` +
          `\nPlease manually upload the following JSON to the Safe Transaction Builder:\n` +
          `${'='.repeat(80)}\n`,
      ),
    );

    console.log(JSON.stringify(jsonPayload, null, 2));

    rootLogger.info(
      chalk.bold.yellow(
        `\n${'='.repeat(80)}\n` +
          `Copy the JSON above and upload it to: https://app.safe.global/transactions/import?safe=${chain}:${safeAddress}\n` +
          `${'='.repeat(80)}\n`,
      ),
    );
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
        ({ callRemoteArgs, description, expandedDescription, ...call }) => {
          // Print a blank line to separate calls
          rootLogger.info('');

          // Print the ICA call header if it exists
          if (callRemoteArgs) {
            rootLogger.info(
              chalk.bold(
                `> INTERCHAIN ACCOUNT CALL: ${chain} -> ${callRemoteArgs.destination}`,
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

    const sendCallsWithSubmitter = async (
      submissionType: SubmissionType,
      submitter: TxSubmitterInterface<ProtocolType.Ethereum>,
      callsForSubmissionType: AnnotatedCallData[],
      fallbackSubmitter?: TxSubmitterInterface<ProtocolType.Ethereum>,
      fallbackSafeAddress?: Address,
    ) => {
      if (callsForSubmissionType.length === 0) {
        return;
      }

      this.printSeparator();
      const confirmed = await summarizeCalls(
        submissionType,
        callsForSubmissionType,
      );
      if (!confirmed) {
        rootLogger.info(
          chalk.italic(
            `Skipping submission of calls on ${chain} via ${SubmissionType[submissionType]}`,
          ),
        );
        return;
      }

      rootLogger.info(
        chalk.italic(
          `Submitting calls on ${chain} via ${SubmissionType[submissionType]}`,
        ),
      );

      // Convert calls to AnnotatedEV5Transaction format
      const annotatedTxs = callsForSubmissionType.map((call) =>
        this.convertToAnnotatedEV5Transaction(chain, call),
      );

      try {
        // Process calls in batches up to max size of 120
        const maxBatchSize = 120;
        for (let i = 0; i < annotatedTxs.length; i += maxBatchSize) {
          const batch = annotatedTxs.slice(i, i + maxBatchSize);
          await submitter.submit(...batch);
        }
      } catch (error) {
        rootLogger.error(
          chalk.red(`Error submitting calls on ${chain}: ${error}`),
        );

        // If we have a fallback submitter (Safe -> JSON Builder), try it
        if (fallbackSubmitter && fallbackSafeAddress) {
          rootLogger.info(
            chalk.yellow(
              `Attempting fallback to JSON generation for manual upload...`,
            ),
          );
          try {
            const jsonPayload = await fallbackSubmitter.submit(...annotatedTxs);
            this.displayFallbackJson(chain, fallbackSafeAddress, jsonPayload);
          } catch (fallbackError) {
            rootLogger.error(
              chalk.red(
                `Fallback JSON generation also failed: ${fallbackError}`,
              ),
            );
          }
        }
        throw error;
      }
    };

    // Do all SIGNER calls first (JSON RPC submitter)
    const signerCalls = filterCalls(SubmissionType.SIGNER);
    if (signerCalls.length > 0) {
      const jsonRpcSubmitter = this.createJsonRpcSubmitter(chain);
      await sendCallsWithSubmitter(
        SubmissionType.SIGNER,
        jsonRpcSubmitter,
        signerCalls,
      );
    }

    // Then propose transactions on safes for all governance types
    for (const governanceType of Object.values(GovernanceType)) {
      const safeAddress = getGovernanceSafes(governanceType)[chain];
      if (!safeAddress) {
        continue;
      }

      const safeCalls = filterCalls(SubmissionType.SAFE, governanceType);
      if (safeCalls.length === 0) {
        continue;
      }

      await retryAsync(
        async () => {
          try {
            const safeSubmitter = await this.createSafeSubmitter(
              chain,
              safeAddress,
            );
            // Create fallback builder for JSON generation
            const fallbackBuilder = await this.createSafeTxBuilder(
              chain,
              safeAddress,
            );
            await sendCallsWithSubmitter(
              SubmissionType.SAFE,
              safeSubmitter,
              safeCalls,
              fallbackBuilder,
              safeAddress,
            );
          } catch (error) {
            // If Safe submitter creation fails (e.g., authorization), try fallback
            rootLogger.warn(
              chalk.yellow(
                `Failed to create Safe submitter, attempting JSON fallback: ${error}`,
              ),
            );
            const fallbackBuilder = await this.createSafeTxBuilder(
              chain,
              safeAddress,
            );
            const annotatedTxs = safeCalls.map((call) =>
              this.convertToAnnotatedEV5Transaction(chain, call),
            );
            const jsonPayload = await fallbackBuilder.submit(...annotatedTxs);
            this.displayFallbackJson(chain, safeAddress, jsonPayload);
            throw error;
          }
        },
        10,
      );
    }

    // Handle ICA calls - these are already encoded and should be submitted to origin chain
    const icaCalls = calls.filter((call) => call.callRemoteArgs !== undefined);
    if (icaCalls.length > 0) {
      // Group ICA calls by origin chain and governance type
      const icaCallsByOrigin = new Map<
        string,
        { calls: AnnotatedCallData[]; governanceType: GovernanceType }
      >();

      for (const call of icaCalls) {
        if (!call.callRemoteArgs || !call.governanceType) {
          continue;
        }
        const origin = call.callRemoteArgs.chain;
        const key = `${origin}-${call.governanceType}`;
        if (!icaCallsByOrigin.has(key)) {
          icaCallsByOrigin.set(key, {
            calls: [],
            governanceType: call.governanceType,
          });
        }
        icaCallsByOrigin.get(key)!.calls.push(call);
      }

      // Submit ICA calls to origin chain via Safe
      for (const [
        key,
        { calls: icaCallGroup, governanceType },
      ] of icaCallsByOrigin.entries()) {
        const [originChain] = key.split('-');
        const originChainName = originChain as ChainName;
        const safeAddress = getGovernanceSafes(governanceType)[originChainName];

        if (!safeAddress) {
          rootLogger.warn(
            chalk.yellow(
              `No Safe address found for ${originChainName} with governance type ${governanceType}, skipping ICA calls`,
            ),
          );
          continue;
        }

        try {
          const icaSubmitter = await this.createIcaSubmitter(
            originChainName,
            governanceType,
          );

          if (icaSubmitter) {
            // Create fallback builder for JSON generation
            const fallbackBuilder = await this.createSafeTxBuilder(
              originChainName,
              safeAddress,
            );
            await sendCallsWithSubmitter(
              SubmissionType.SAFE, // ICA calls are submitted via Safe on origin
              icaSubmitter,
              icaCallGroup,
              fallbackBuilder,
              safeAddress,
            );
          } else {
            // Fallback to JSON if submitter creation fails
            rootLogger.warn(
              chalk.yellow(
                `Failed to create ICA submitter for ${originChainName}, falling back to JSON generation`,
              ),
            );
            const fallbackBuilder = await this.createSafeTxBuilder(
              originChainName,
              safeAddress,
            );
            const annotatedTxs = icaCallGroup.map((call) =>
              this.convertToAnnotatedEV5Transaction(originChainName, call),
            );
            const jsonPayload = await fallbackBuilder.submit(...annotatedTxs);
            this.displayFallbackJson(originChainName, safeAddress, jsonPayload);
          }
        } catch (error) {
          rootLogger.error(
            chalk.red(
              `Error submitting ICA calls for ${originChainName}: ${error}`,
            ),
          );
          // Try JSON fallback
          try {
            const fallbackBuilder = await this.createSafeTxBuilder(
              originChainName,
              safeAddress,
            );
            const annotatedTxs = icaCallGroup.map((call) =>
              this.convertToAnnotatedEV5Transaction(originChainName, call),
            );
            const jsonPayload = await fallbackBuilder.submit(...annotatedTxs);
            this.displayFallbackJson(originChainName, safeAddress, jsonPayload);
          } catch (fallbackError) {
            rootLogger.error(
              chalk.red(
                `JSON fallback also failed for ${originChainName}: ${fallbackError}`,
              ),
            );
          }
        }
      }
    }

    // Then finally submit remaining calls manually (Safe Transaction Builder)
    const manualCalls = filterCalls(SubmissionType.MANUAL);
    if (manualCalls.length > 0) {
      // For manual calls, we need to determine which Safe to use
      // Try to find a Safe address, otherwise use the first available
      let manualSafeAddress: Address | undefined;
      for (const governanceType of Object.values(GovernanceType)) {
        const safe = getGovernanceSafes(governanceType)[chain];
        if (safe) {
          manualSafeAddress = safe;
          break;
        }
      }

      if (manualSafeAddress) {
        const manualBuilder = await this.createSafeTxBuilder(
          chain,
          manualSafeAddress,
        );
        const annotatedTxs = manualCalls.map((call) =>
          this.convertToAnnotatedEV5Transaction(chain, call),
        );
        const jsonPayload = await manualBuilder.submit(...annotatedTxs);
        this.displayFallbackJson(chain, manualSafeAddress, jsonPayload);
      } else {
        // No Safe found, just print the calls
        rootLogger.info(
          `Please submit the following manually to ${chain}:`,
        );
        console.log(JSON.stringify(manualCalls, null, 2));
      }
    }

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
        callRemoteArgs: inferredCall.callRemoteArgs,
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

    let accountConfig = this.interchainAccount.knownAccounts[account.address];

    if (!accountConfig) {
      let ownerType: Owner | null;
      let icaGovernanceType: GovernanceType;

      // Backstop to still be able to parse legacy Abacus Works ICAs
      if (eqAddress(account.address, awIcasLegacy[chain])) {
        ownerType = Owner.ICA;
        icaGovernanceType = GovernanceType.AbacusWorks;
      } else if (eqAddress(account.address, regularIcasLegacy[chain])) {
        ownerType = Owner.ICA;
        icaGovernanceType = GovernanceType.Regular;
      } else {
        ({ ownerType, governanceType: icaGovernanceType } =
          await determineGovernanceType(chain, account.address));
      }

      // verify that we expect it to be an ICA
      assert(ownerType === Owner.ICA, 'ownerType should be ICA');
      // get the set of safes for this governance type
      const safes = getGovernanceSafes(icaGovernanceType);
      const origin = 'ethereum';
      const remoteOwner = safes[origin];
      accountConfig = {
        origin,
        owner: remoteOwner,
        ...(legacyIcaChainRouters[chain]
          ? {
              localRouter: legacyEthIcaRouter,
              routerOverride:
                legacyIcaChainRouters[chain].interchainAccountRouter,
            }
          : {}),
      };
    }

    // WARNING: origin is a reserved word in TypeScript
    const origin = accountConfig.origin;

    // Check that it derives to the ICA
    const derivedIca = await this.interchainAccount.getAccount(
      chain,
      accountConfig,
    );

    if (!eqAddress(derivedIca, account.address)) {
      console.info(
        chalk.gray(
          `Account ${account.address} is not the expected ICA ${derivedIca}. Defaulting to manual submission.`,
        ),
      );
      return {
        type: SubmissionType.MANUAL,
        chain,
        call,
      };
    }

    rootLogger.info(
      chalk.gray(
        `Inferred call for ICA remote owner ${bytes32ToAddress(
          accountConfig.owner,
        )} on ${origin} to ${chain}`,
      ),
    );

    // Get the encoded call to the remote ICA
    const callRemoteArgs: GetCallRemoteSettings = {
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
    };
    const callRemote =
      await this.interchainAccount.getCallRemote(callRemoteArgs);

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
          eqAddress(bytes32ToAddress(accountConfig!.owner), submitterAddress)
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
        callRemoteArgs,
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

      // If it's not an ICA call, check if the submitter is the owner of the contract
      try {
        if (!isICACall) {
          const ownable = Ownable__factory.connect(call.to, signer);
          const owner = await ownable.owner();
          const isOwner = eqAddress(owner, submitterAddress);

          if (!isOwner) {
            return false;
          }
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

    // Fallback to manual submission if we're on a ZkSync chain.
    // This is because we are not allowed to estimate gas for non-signer addresses on ZkSync.
    // And if we can't simulate the transaction, we can't know for sure ourselves which safe to submit it to.
    const { technicalStack } = multiProvider.getChainMetadata(chain);
    if (technicalStack === ChainTechnicalStack.ZkSync) {
      return { type: SubmissionType.MANUAL, chain, call };
    }

    // Check if the transaction will succeed with a SAFE
    // Need to check all governance types because the safe address is different for each type
    for (const governanceType of Object.values(GovernanceType)) {
      const safeAddress = getGovernanceSafes(governanceType)[chain];
      if (
        typeof safeAddress === 'string' &&
        (await checkTransactionSuccess(chain, safeAddress))
      ) {
        call.governanceType = governanceType;
        // If the transaction will succeed with the safe, return the inferred call
        return { type: SubmissionType.SAFE, chain, call };
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
