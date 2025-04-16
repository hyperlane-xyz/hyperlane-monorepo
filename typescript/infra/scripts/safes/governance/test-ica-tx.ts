import chalk from 'chalk';
import { BigNumber } from 'ethers';
import prompts from 'prompts';
import yargs from 'yargs';

import { Ownable__factory } from '@hyperlane-xyz/core';
import {
  ChainName,
  InterchainAccount,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  bytes32ToAddress,
  configureRootLogger,
  eqAddress,
  objFilter,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { regularSafes } from '../../../config/environments/mainnet3/governance/safe/regular.js';
import {
  getGovernanceIcas,
  getGovernanceSafes,
} from '../../../config/environments/mainnet3/governance/utils.js';
import {
  AnnotatedCallData,
  InferredCall,
  SubmissionType,
} from '../../../src/govern/HyperlaneAppGovernor.js';
import { SafeMultiSend } from '../../../src/govern/multisend.js';
import { GovernanceType } from '../../../src/governance.js';
import { withChainsRequired } from '../../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../../core-utils.js';

async function inferICACall({
  chain,
  call,
  multiProvider,
  interchainAccount,
}: {
  chain: ChainName;
  call: AnnotatedCallData;
  multiProvider: MultiProvider;
  interchainAccount: InterchainAccount;
}): Promise<InferredCall> {
  const signer = multiProvider.getSigner(chain);

  // If there is no ICA, default to manual submission
  if (!interchainAccount) {
    throw new Error('InterchainAccount App not initialized');
  }

  // Get the account's owner
  const account = Ownable__factory.connect(call.to, signer);
  rootLogger.info(`Connected to Account contract at: ${call.to}`);
  const localOwner = await account.owner();
  rootLogger.info(`Local Owner: ${localOwner}`);

  // If the account's owner is not the ICA router, default to manual submission
  const routerAddress = interchainAccount.routerAddress(chain);
  rootLogger.info(
    chalk.gray(
      `Comparing local owner ${localOwner} with ICA router address ${routerAddress}`,
    ),
  );
  if (!eqAddress(localOwner, routerAddress)) {
    rootLogger.info(
      chalk.gray(
        `Account's owner ${localOwner} is not ICA router. Defaulting to manual submission.`,
      ),
    );
    throw new Error('Invalid call to remote ICA');
  }

  // Get the account's config
  const accountConfig = await interchainAccount.getAccountConfig(
    chain,
    account.address,
  );
  const origin = interchainAccount.multiProvider.getChainName(
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
  const callRemote = await interchainAccount.getCallRemote({
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
    throw new Error('Invalid call to remote ICA');
  }

  // If the call to the remote ICA is valid, infer the submission type
  const { description, expandedDescription } = call;
  const encodedCall: AnnotatedCallData = {
    to: callRemote.to,
    data: callRemote.data,
    value: callRemote.value,
    description,
    expandedDescription,
  };

  const safeOwner = regularSafes[origin];
  if (!safeOwner) {
    throw new Error(`Safe owner not found for ${origin}`);
  }
  if (!eqAddress(safeOwner, bytes32ToAddress(accountConfig.owner))) {
    throw new Error(
      `Safe owner ${safeOwner} does not match ICA owner ${accountConfig.owner}`,
    );
  }

  return {
    type: SubmissionType.SAFE,
    chain: origin,
    call: encodedCall,
    icaTargetChain: chain,
  };
}

async function summarizeCalls(
  chain: ChainName,
  submissionType: SubmissionType,
  callsForSubmissionType: AnnotatedCallData[],
): Promise<boolean> {
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

  const { value: confirmed } = await prompts({
    type: 'confirm',
    name: 'value',
    message: 'Can you confirm?',
    initial: false,
  });

  return !!confirmed;
}

const hubChain = 'ethereum';
const environment = 'mainnet3';
const governanceType = GovernanceType.Regular;

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { chains } = await withChainsRequired(yargs(process.argv.slice(2)))
    .argv;

  const safes = getGovernanceSafes(governanceType);
  const icas = getGovernanceIcas(governanceType);

  const hubSafe = safes[hubChain];
  if (!hubSafe) {
    throw new Error(`Hub safe not found for ${hubChain}`);
  }

  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider();
  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);
  const icaChainAddresses = objFilter(
    chainAddresses,
    (chain, _): _ is Record<string, string> =>
      !!chainAddresses[chain]?.interchainAccountRouter,
  );
  const interchainAccount = InterchainAccount.fromAddressesMap(
    icaChainAddresses,
    multiProvider,
  );

  const calls: AnnotatedCallData[] = [];
  for (const chain of chains) {
    if (!icas[chain]) {
      rootLogger.warn(chalk.yellow(`No ICA deployed for ${chain}`));
      continue;
    }

    const remoteCall: AnnotatedCallData = {
      to: icas[chain],
      data: '0x',
      value: BigNumber.from(0),
      submissionType: SubmissionType.SAFE,
      icaTargetChain: chain,
      description: `Test sending 0 from ICA on ${chain} to itself`,
    };
    const inferredCall = await inferICACall({
      chain,
      call: remoteCall,
      multiProvider,
      interchainAccount,
    });
    calls.push(inferredCall.call);
  }

  await summarizeCalls(hubChain, SubmissionType.SAFE, calls);

  const safeMultiSend = new SafeMultiSend(multiProvider, hubChain, hubSafe);
  await safeMultiSend.sendTransactions(calls);
}

// Execute the main function and handle promise
main().catch((error) => {
  rootLogger.error('An error occurred:', error);
  process.exit(1);
});
