import os from 'os';
import { Options } from 'yargs';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { LogFormat, LogLevel } from '@hyperlane-xyz/utils';

import { ENV } from '../utils/env.js';

/* Global options */

export const demandOption = (option: Options): Options => ({
  ...option,
  demandOption: true,
});

export const logFormatCommandOption: Options = {
  type: 'string',
  description: 'Log output format',
  choices: Object.values(LogFormat),
};

export const logLevelCommandOption: Options = {
  type: 'string',
  description: 'Log verbosity level',
  choices: Object.values(LogLevel),
};

export const registryUriCommandOption: Options = {
  type: 'string',
  description: 'Registry URI, such as a Github repo URL or a local file path',
  alias: 'r',
  default: DEFAULT_GITHUB_REGISTRY,
};

export const overrideRegistryUriCommandOption: Options = {
  type: 'string',
  description: 'Path to a local registry to override the default registry',
  default: `${os.homedir()}/.hyperlane`,
};

export const skipConfirmationOption: Options = {
  type: 'boolean',
  description: 'Skip confirmation prompts',
  default: false,
  alias: 'y',
};

export const keyCommandOption: Options = {
  type: 'string',
  description:
    'A hex private key or seed phrase for transaction signing, or use the HYP_KEY env var.',
  alias: ['k', 'private-key', 'seed-phrase'],
  default: ENV.HYP_KEY,
  defaultDescription: 'process.env.HYP_KEY',
};

/* Command-specific options */

export const coreTargetsCommandOption: Options = {
  type: 'string',
  description:
    'Comma separated list of chain names to which contracts will be deployed',
};

export const agentTargetsCommandOption: Options = {
  type: 'string',
  description: 'Comma separated list of chains to relay between',
};

export const originCommandOption: Options = {
  type: 'string',
  description: 'The name of the origin chain to deploy to',
};

export const ismCommandOption: Options = {
  type: 'string',
  description:
    'A path to a JSON or YAML file with basic or advanced ISM configs (e.g. Multisig)',
};

export const hookCommandOption: Options = {
  type: 'string',
  description:
    'A path to a JSON or YAML file with Hook configs (for every chain)',
};

export const warpDeploymentConfigCommandOption: Options = {
  type: 'string',
  description:
    'A path to a JSON or YAML file with a warp route deployment config.',
  default: './configs/warp-route-deployment.yaml',
  alias: 'wd',
};

export const warpCoreConfigCommandOption: Options = {
  type: 'string',
  description: 'File path to Warp Route config',
  alias: 'wc',
};

export const agentConfigCommandOption = (
  isIn: boolean,
  defaultPath?: string,
): Options => ({
  type: 'string',
  description: `${
    isIn ? 'Input' : 'Output'
  } file path for the agent configuration`,
  default: defaultPath,
});

export const chainTargetsCommandOption: Options = {
  type: 'string',
  description: 'Comma-separated list of chain names',
  alias: 'c',
};

export const outputFileCommandOption = (
  defaultPath?: string,
  demandOption = false,
  description = 'Output file path',
): Options => ({
  type: 'string',
  description,
  default: defaultPath,
  alias: 'o',
  demandOption,
});

export const inputFileCommandOption: Options = {
  type: 'string',
  description: 'Input file path',
  alias: 'i',
  demandOption: true,
};

export const fromAddressCommandOption: Options = {
  type: 'string',
  description: `An address to simulate transaction signing on a forked network`,
  alias: 'f',
};

export const dryRunCommandOption: Options = {
  type: 'string',
  description:
    'Chain name to fork and simulate deployment. Please ensure an anvil node instance is running during execution via `anvil`.',
  alias: 'd',
};

export const chainCommandOption: Options = {
  type: 'string',
  description: 'The specific chain to perform operations with.',
};

export const symbolCommandOption: Options = {
  type: 'string',
  description: 'Token symbol (e.g. ETH, USDC)',
};

export const validatorCommandOption: Options = {
  type: 'string',
  description: 'Comma separated list of validator addresses',
  demandOption: true,
};

export const transactionsCommandOption: Options = {
  type: 'string',
  description: 'The transaction input file path.',
  alias: ['t', 'txs', 'txns'],
  demandOption: true,
};

export const strategyCommandOption: Options = {
  type: 'string',
  description: 'The submission strategy input file path.',
  alias: 's',
  demandOption: true,
};

export const addressCommandOption = (
  description: string,
  demandOption = false,
): Options => ({
  type: 'string',
  description,
  demandOption,
});

/* Validator options */
export const awsAccessKeyCommandOption: Options = {
  type: 'string',
  description: 'AWS access key of IAM user associated with validator',
  default: ENV.AWS_ACCESS_KEY_ID,
  defaultDescription: 'process.env.AWS_ACCESS_KEY_ID',
};

export const awsSecretKeyCommandOption: Options = {
  type: 'string',
  description: 'AWS secret access key of IAM user associated with validator',
  default: ENV.AWS_SECRET_ACCESS_KEY,
  defaultDescription: 'process.env.AWS_SECRET_ACCESS_KEY',
};

export const awsRegionCommandOption: Options = {
  type: 'string',
  describe: 'AWS region associated with validator',
  default: ENV.AWS_REGION,
  defaultDescription: 'process.env.AWS_REGION',
};

export const awsBucketCommandOption: Options = {
  type: 'string',
  describe: 'AWS S3 bucket containing validator signatures and announcement',
};

export const awsKeyIdCommandOption: Options = {
  type: 'string',
  describe: 'Key ID from AWS KMS',
};

export const operatorKeyPathCommandOption: Options = {
  type: 'string',
  description: 'Path to the operator key file',
};

export const avsChainCommandOption: Options = {
  type: 'string',
  description: 'Chain to interact with the AVS on',
  demandOption: true,
  choices: ['holesky', 'ethereum'],
};
