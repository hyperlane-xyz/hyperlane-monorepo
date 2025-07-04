import { confirm, input, password, select } from '@inquirer/prompts';
import { Wallet } from 'ethers';
import { stringify as yamlStringify } from 'yaml';

import {
  ChainSubmissionStrategy,
  ChainSubmissionStrategySchema,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  errorToString,
  isAddress,
  isPrivateKeyEvm,
} from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, log, logBlue, logGreen, logRed } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import {
  indentYamlOrJson,
  isFile,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';
import { maskSensitiveData } from '../utils/output.js';

/**
 * Reads and validates a chain submission strategy configuration from a file
 */
export async function readChainSubmissionStrategyConfig(
  filePath: string,
): Promise<ChainSubmissionStrategy> {
  log(`Reading submission strategy in ${filePath}`);
  const strategyConfig = readYamlOrJson<ChainSubmissionStrategy>(filePath);
  const parseResult = ChainSubmissionStrategySchema.parse(strategyConfig);
  return parseResult;
}

/**
 * Safely reads chain submission strategy config, returns empty object if any errors occur
 */
export async function safeReadChainSubmissionStrategyConfig(
  filePath: string,
): Promise<ChainSubmissionStrategy> {
  try {
    const trimmedFilePath = filePath.trim();
    if (!isFile(trimmedFilePath)) {
      logBlue(`File ${trimmedFilePath} does not exist, returning empty config`);
      return {};
    }
    return await readChainSubmissionStrategyConfig(trimmedFilePath);
  } catch (error) {
    logRed(
      `Failed to read strategy config, defaulting to empty config:`,
      errorToString(error),
    );
    return {};
  }
}

export async function createStrategyConfig({
  context,
  outPath,
}: {
  context: CommandContext;
  outPath: string;
}) {
  let strategy: ChainSubmissionStrategy;
  try {
    const strategyObj = await readYamlOrJson(outPath);
    strategy = ChainSubmissionStrategySchema.parse(strategyObj);
  } catch {
    strategy = writeYamlOrJson(outPath, {}, 'yaml');
  }

  const chain = await runSingleChainSelectionStep(context.chainMetadata);
  const chainProtocol = context.chainMetadata[chain].protocol;

  if (
    !context.skipConfirmation &&
    strategy &&
    Object.prototype.hasOwnProperty.call(strategy, chain)
  ) {
    const isConfirmed = await confirm({
      message: `Default strategy for chain ${chain} already exists. Are you sure you want to overwrite existing strategy config?`,
      default: false,
    });

    assert(isConfirmed, 'Strategy initialization cancelled by user.');
  }

  const isEthereum = chainProtocol === ProtocolType.Ethereum;
  const submitterType = isEthereum
    ? await select({
        message: 'Select the submitter type',
        choices: Object.values(TxSubmitterType).map((value) => ({
          name: value,
          value: value,
        })),
      })
    : TxSubmitterType.JSON_RPC; // Do other non-evm chains support gnosis and account impersonation?

  const submitter: Record<string, any> = { type: submitterType };

  switch (submitterType) {
    case TxSubmitterType.JSON_RPC:
      submitter.privateKey = await password({
        message: 'Enter the private key for JSON-RPC submission:',
        validate: (pk) => (isEthereum ? isPrivateKeyEvm(pk) : true),
      });

      submitter.userAddress = isEthereum
        ? await new Wallet(submitter.privateKey).getAddress()
        : await input({
            message: 'Enter the user address for JSON-RPC submission:',
          });

      submitter.chain = chain;
      break;

    case TxSubmitterType.IMPERSONATED_ACCOUNT:
      submitter.userAddress = await input({
        message: 'Enter the user address to impersonate',
        validate: (address) =>
          isAddress(address) ? true : 'Invalid Ethereum address',
      });
      assert(
        submitter.userAddress,
        'User address is required for impersonated account',
      );
      break;

    case TxSubmitterType.GNOSIS_SAFE:
    case TxSubmitterType.GNOSIS_TX_BUILDER:
      submitter.safeAddress = await input({
        message: 'Enter the Safe address',
        validate: (address) =>
          isAddress(address) ? true : 'Invalid Safe address',
      });

      submitter.chain = chain;

      if (submitterType === TxSubmitterType.GNOSIS_TX_BUILDER) {
        submitter.version = await input({
          message: 'Enter the Safe version (default: 1.0)',
          default: '1.0',
        });
      }
      break;

    default:
      throw new Error(`Unsupported submitter type: ${submitterType}`);
  }

  const strategyResult: ChainSubmissionStrategy = {
    ...strategy,
    [chain]: {
      submitter: submitter as ChainSubmissionStrategy[string]['submitter'],
    },
  };

  try {
    const strategyConfig = ChainSubmissionStrategySchema.parse(strategyResult);
    logBlue(`Strategy configuration is valid. Writing to file ${outPath}:\n`);

    const maskedConfig = maskSensitiveData(strategyConfig);
    log(indentYamlOrJson(yamlStringify(maskedConfig, null, 2), 4));

    writeYamlOrJson(outPath, strategyConfig);
    logGreen('✅ Successfully created a new strategy configuration.');
  } catch {
    // don't log error since it may contain sensitive data
    errorRed(
      `The strategy configuration is invalid. Please review the submitter settings.`,
    );
  }
}
