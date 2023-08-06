import { confirm, input } from '@inquirer/prompts';
import select from '@inquirer/select';
import { CommandModule } from 'yargs';

import { ChainMetadata, isValidChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readChainConfig } from '../configs.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import { FileFormat, mergeYamlOrJson } from '../utils/files.js';

/**
 * Parent command
 */
export const configCommand: CommandModule = {
  command: 'config',
  describe: 'Create or validate Hyperlane configs',
  builder: (yargs) =>
    yargs
      .command(createCommand)
      .command(validateCommand)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

/**
 * Create command
 */
const createCommand: CommandModule = {
  command: 'create',
  describe: 'Create a new, minimal Hyperlane config',
  builder: (yargs) =>
    yargs.options({
      output: {
        type: 'string',
        alias: 'o',
        description: 'Output file path',
      },
      format: {
        type: 'string',
        alias: 'f',
        description: 'Output file format',
        choices: ['json', 'yaml'],
      },
    }),
  handler: async (argv: any) => {
    const format: FileFormat = argv.format || 'yaml';
    const output: string = argv.output || `./configs/chain-config.${format}`;
    logBlue('Creating a new chain config');
    const name = await input({
      message: 'Enter chain name (one word, lower case)',
    });
    const chainId = await input({ message: 'Enter chain id (number)' });
    const skipDomain = await confirm({
      message: 'Will the domainId match the chainId (recommended)?',
    });
    let domainId: string;
    if (skipDomain) {
      domainId = chainId;
    } else {
      domainId = await input({
        message: 'Enter domain id (number, often matches chainId)',
      });
    }
    const protocol = await select({
      message: 'Select protocol type',
      choices: Object.values(ProtocolType).map((protocol) => ({
        name: protocol,
        value: protocol,
      })),
    });
    const rpcUrl = await input({ message: 'Enter http or https rpc url' });
    const metadata: ChainMetadata = {
      name,
      chainId: parseInt(chainId, 10),
      domainId: parseInt(domainId, 10),
      protocol,
      rpcUrls: [{ http: rpcUrl }],
    };
    if (isValidChainMetadata(metadata)) {
      logGreen(`Chain config is valid, writing to file ${output}`);
      mergeYamlOrJson(output, { [name]: metadata }, format);
    } else {
      errorRed(
        `Chain config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/chain-config.yaml for an example`,
      );
      throw new Error('Invalid chain config');
    }
    process.exit(0);
  },
};

/**
 * Validate command
 */
const validateCommand: CommandModule = {
  command: 'validate',
  describe: 'Validate the configs in a YAML or JSON file',
  builder: (yargs) =>
    yargs.options({
      path: {
        type: 'string',
        description: 'Input file path',
        demandOption: true,
      },
    }),
  handler: async (argv) => {
    const path = argv.path as string;
    readChainConfig(path);
  },
};
