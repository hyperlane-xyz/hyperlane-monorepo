import { Options } from 'yargs';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { LogFormat, LogLevel } from '@hyperlane-xyz/utils';

import { ENV } from '../utils/env.js';

/* Global options */

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
  default: './',
};

export const skipConfirmationOption: Options = {
  type: 'boolean',
  description: 'Skip confirmation prompts',
  default: false,
  alias: 'y',
};

export const keyCommandOption: Options = {
  type: 'string',
  description: `A hex private key or seed phrase for transaction signing, or use the HYP_KEY env var.
Dry-run: An address to simulate transaction signing on a forked network`,
  alias: 'k',
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

export const warpConfigCommandOption: Options = {
  type: 'string',
  description:
    'A path to a JSON or YAML file with a warp route deployment config.',
  default: './configs/warp-route-deployment.yaml',
  alias: 'w',
};

export const warpConfigOption: Options = {
  type: 'string',
  description: 'File path to Warp Route config',
  alias: 'w',
  // TODO make this optional and have the commands get it from the registry
  demandOption: true,
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

export const outputFileOption = (defaultPath?: string): Options => ({
  type: 'string',
  description: 'Output file path',
  default: defaultPath,
  alias: 'o',
});

export const inputFileOption: Options = {
  type: 'string',
  description: 'Input file path',
  alias: 'i',
  demandOption: true,
};

export const dryRunOption: Options = {
  type: 'string',
  description:
    'Chain name to fork and simulate deployment. Please ensure an anvil node instance is running during execution via `anvil`.',
  alias: 'd',
};

export const chainCommandOption: Options = {
  type: 'string',
  description: 'The specific chain to perform operations with.',
};

export const addressCommandOption = (
  description: string,
  demandOption = false,
): Options => ({
  type: 'string',
  description,
  demandOption,
});
