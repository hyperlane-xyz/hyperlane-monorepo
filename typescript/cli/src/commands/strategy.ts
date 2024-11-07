// import { input, select } from '@inquirer/prompts';
import { input, select } from '@inquirer/prompts';
import { ethers } from 'ethers';
import { stringify as yamlStringify } from 'yaml';
import { CommandModule } from 'yargs';

import {
  ChainSubmissionStrategy,
  ChainSubmissionStrategySchema,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { CommandModuleWithWriteContext } from '../context/types.js';
import {
  errorRed,
  log,
  logBlue,
  logCommandHeader,
  logGreen,
} from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import {
  indentYamlOrJson,
  mergeYamlOrJson,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';

import {
  DEFAULT_STRATEGY_CONFIG_PATH,
  outputFileCommandOption,
} from './options.js';

/**
 * Parent command
 */
export const strategyCommand: CommandModule = {
  command: 'strategy',
  describe: 'Manage Hyperlane deployment strategies',
  builder: (yargs) => yargs.command(init).version(false).demandCommand(),
  handler: () => log('Command required'),
};

export const init: CommandModuleWithWriteContext<{
  chain: string;
  config: string;
}> = {
  command: 'init',
  describe: 'Initiates strategy',
  builder: {
    config: outputFileCommandOption(
      DEFAULT_STRATEGY_CONFIG_PATH,
      false,
      'The path to output a Key Config JSON or YAML file.',
    ),
    type: {
      type: 'string',
      description:
        'Type of submitter (jsonRpc, impersonatedAccount, gnosisSafe, gnosisSafeTxBuilder)',
    },
    safeAddress: {
      type: 'string',
      description:
        'Safe address (required for gnosisSafe and gnosisSafeTxBuilder types)',
    },
    userAddress: {
      type: 'string',
      description: 'User address (required for impersonatedAccount type)',
    },
  },
  handler: async ({
    context,
    type: inputType,
    safeAddress: inputSafeAddress,
    userAddress: inputUserAddress,
  }) => {
    logCommandHeader(`Hyperlane Key Init`);

    try {
      await readYamlOrJson(DEFAULT_STRATEGY_CONFIG_PATH);
    } catch (e) {
      writeYamlOrJson(DEFAULT_STRATEGY_CONFIG_PATH, {}, 'yaml');
    }

    const chain = await runSingleChainSelectionStep(context.chainMetadata);
    const chainProtocol = context.chainMetadata[chain].protocol;
    assert(chainProtocol === ProtocolType.Ethereum, 'Incompatible protocol');

    // If type wasn't provided via command line, prompt for it
    const type =
      inputType ||
      (await select({
        message: 'Enter the type of submitter',
        choices: Object.values(TxSubmitterType).map((value) => ({
          name: value,
          value: value,
        })),
      }));

    let submitter: any = {
      type: type,
    };

    // Configure submitter based on type
    switch (type) {
      case TxSubmitterType.JSON_RPC:
        const privateKey = await input({
          message: 'Enter your private key',
          validate: (pk) => isValidPrivateKey(pk),
        });
        submitter.privateKey = privateKey;
        break;

      case TxSubmitterType.IMPERSONATED_ACCOUNT:
        const userAddress =
          inputUserAddress ||
          (await input({
            message: 'Enter the user address to impersonate',
            validate: (address) => {
              try {
                return ethers.utils.isAddress(address)
                  ? true
                  : 'Invalid Ethereum address';
              } catch {
                return 'Invalid Ethereum address';
              }
            },
          }));
        assert(
          userAddress,
          'User address is required for impersonated account',
        );
        submitter.userAddress = userAddress;
        break;

      case TxSubmitterType.GNOSIS_SAFE:
      case TxSubmitterType.GNOSIS_TX_BUILDER:
        const safeAddress =
          inputSafeAddress ||
          (await input({
            message: 'Enter the Safe address',
            validate: (address) => {
              try {
                return ethers.utils.isAddress(address)
                  ? true
                  : 'Invalid Safe address';
              } catch {
                return 'Invalid Safe address';
              }
            },
          }));
        assert(safeAddress, 'Safe address is required for Gnosis Safe');

        submitter = {
          type: type,
          chain: chain,
          safeAddress: safeAddress,
        };

        if (type === TxSubmitterType.GNOSIS_TX_BUILDER) {
          const version = await input({
            message: 'Enter the Safe version (default: 1.0)',
            default: '1.0',
          });
          submitter.version = version;
        }
        break;

      default:
        throw new Error(`Unsupported submitter type: ${type}`);
    }

    let result: ChainSubmissionStrategy = {
      [chain]: {
        submitter: submitter,
      },
    };

    try {
      const strategyConfig = ChainSubmissionStrategySchema.parse(result);
      logBlue(
        `Strategy config is valid, writing to file ${DEFAULT_STRATEGY_CONFIG_PATH}:\n`,
      );
      log(indentYamlOrJson(yamlStringify(strategyConfig, null, 2), 4));

      mergeYamlOrJson(DEFAULT_STRATEGY_CONFIG_PATH, strategyConfig);
      logGreen('✅ Successfully created new key config.');
    } catch (e) {
      errorRed(
        `Key config is invalid, please check the submitter configuration.`,
      );
      throw e;
    }
    process.exit(0);
  },
};

function isValidPrivateKey(privateKey: string): boolean {
  try {
    // Attempt to create a Wallet instance with the private key
    const wallet = new ethers.Wallet(privateKey);
    return wallet.privateKey === privateKey;
  } catch (error) {
    return false;
  }
}
