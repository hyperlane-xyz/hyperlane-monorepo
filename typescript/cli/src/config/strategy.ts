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
  isAddress,
  isPrivateKeyEvm,
} from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import {
  indentYamlOrJson,
  isFile,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';

export async function readChainSubmissionStrategyConfig(
  filePath: string,
): Promise<ChainSubmissionStrategy> {
  try {
    log(`Reading file configs in ${filePath}`);

    if (!isFile(filePath.trim())) {
      logBlue(
        `No strategy config found in ${filePath}, returning empty config`,
      );
      return {};
    }

    const strategyConfig = readYamlOrJson<ChainSubmissionStrategy>(
      filePath.trim(),
    );

    // Check if config exists and is a non-empty object
    if (!strategyConfig || typeof strategyConfig !== 'object') {
      logBlue(
        `No strategy config found in ${filePath}, returning empty config`,
      );
      return {};
    }

    // Validate against schema
    const parseResult = ChainSubmissionStrategySchema.safeParse(strategyConfig);
    if (!parseResult.success) {
      errorRed(`Strategy config validation failed for ${filePath}`);
      errorRed(JSON.stringify(parseResult.error.errors, null, 2));
      throw new Error('Invalid strategy configuration');
    }

    return strategyConfig;
  } catch (error) {
    if (error instanceof Error) {
      errorRed(`Error reading strategy config: ${error.message}`);
    } else {
      errorRed('Unknown error reading strategy config');
    }
    throw error; // Re-throw to let caller handle the error
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
    // the output strategy might contain submitters for other chain we don't want to overwrite
    const strategyObj = await readYamlOrJson(outPath);
    strategy = ChainSubmissionStrategySchema.parse(strategyObj);
  } catch (e) {
    strategy = writeYamlOrJson(outPath, {}, 'yaml');
  }
  const chain = await runSingleChainSelectionStep(context.chainMetadata);
  const chainProtocol = context.chainMetadata[chain].protocol;
  assert(chainProtocol === ProtocolType.Ethereum, 'Incompatible protocol'); // Needs to be compatible with MultiProvider - ethers.Signer

  if (
    !context.skipConfirmation &&
    strategy &&
    Object.prototype.hasOwnProperty.call(strategy, chain)
  ) {
    const isConfirmed = await confirm({
      message: `Default strategy for chain ${chain} already exists. Are you sure you want to overwrite existing strategy config?`,
      default: false,
    });

    if (!isConfirmed) {
      throw Error('Strategy init cancelled');
    }
  }

  const type = await select({
    message: 'Enter the type of submitter',
    choices: Object.values(TxSubmitterType).map((value) => ({
      name: value,
      value: value,
    })),
  });

  const submitter: any = {
    type: type,
  };

  // Configure submitter based on type
  switch (type) {
    case TxSubmitterType.JSON_RPC:
      submitter.privateKey = await password({
        message: 'Enter your private key',
        validate: (pk) => isPrivateKeyEvm(pk),
      });

      submitter.userAddress = await new Wallet(
        submitter.privateKey,
      ).getAddress(); // EVM

      submitter.chain = chain;
      break;

    case TxSubmitterType.IMPERSONATED_ACCOUNT:
      submitter.userAddress = await input({
        message: 'Enter the user address to impersonate',
        validate: (address) => {
          try {
            return isAddress(address) ? true : 'Invalid Ethereum address';
          } catch {
            return 'Invalid Ethereum address';
          }
        },
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
        validate: (address) => {
          try {
            return isAddress(address) ? true : 'Invalid Safe address';
          } catch {
            return 'Invalid Safe address';
          }
        },
      });

      submitter.chain = chain;

      if (type === TxSubmitterType.GNOSIS_TX_BUILDER) {
        submitter.version = await input({
          message: 'Enter the Safe version (default: 1.0)',
          default: '1.0',
        });
      }
      break;

    default:
      throw new Error(`Unsupported submitter type: ${type}`);
  }

  const strategyResult: ChainSubmissionStrategy = {
    ...strategy, // if there are changes in ChainSubmissionStrategy, the strategy may no longer be compatible
    [chain]: {
      submitter: submitter,
    },
  };

  try {
    const strategyConfig = ChainSubmissionStrategySchema.parse(strategyResult);
    logBlue(`Strategy config is valid, writing to file ${outPath}:\n`);

    // Mask sensitive data before logging
    const maskedConfig = maskSensitiveData(strategyConfig);
    log(indentYamlOrJson(yamlStringify(maskedConfig, null, 2), 4));

    // Write the original unmasked config to file
    writeYamlOrJson(outPath, strategyConfig);
    logGreen('✅ Successfully created new key config.');
  } catch (e) {
    errorRed(
      `Key config is invalid, please check the submitter configuration.`,
    );
  }
}

// TODO: put in utils
// New utility function to mask sensitive data
export function maskPrivateKey(key: string): string {
  if (!key) return key;
  const middle = '•'.repeat(key.length);
  return `${middle}`;
}

// Function to recursively mask private keys in an object
export function maskSensitiveData(obj: any): any {
  if (!obj) return obj;

  if (typeof obj === 'object') {
    const masked = { ...obj };
    for (const [key, value] of Object.entries(masked)) {
      if (key === 'privateKey' && typeof value === 'string') {
        masked[key] = maskPrivateKey(value);
      } else if (typeof value === 'object') {
        masked[key] = maskSensitiveData(value);
      }
    }
    return masked;
  }

  return obj;
}
