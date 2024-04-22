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

export const configOverridesUriCommandOption: Options = {
  type: 'string',
  description: 'Path to local folder with configs and artifacts',
  default: './',
  alias: 'c',
};

/* Command-specific options */

export type CommandOptions = {
  chains: Options;
};
export type AgentCommandOptions = CommandOptions & {
  origin: Options;
  targets: Options;
  config: Options;
};
export type CoreCommandOptions = CommandOptions & {
  targets: Options;
  artifacts: Options;
  ism: Options;
  hook: Options;
  out: Options;
  key: Options;
  yes: Options;
  'dry-run': Options;
};
export type WarpCommandOptions = CommandOptions & {
  config: Options;
  core: Options;
  out: Options;
  key: Options;
  yes: Options;
  'dry-run': Options;
};

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

export const keyCommandOption: Options = {
  type: 'string',
  description: `Default: A hex private key or seed phrase for transaction signing, or use the HYP_KEY env var.
Dry-run: An address to simulate transaction signing on a forked network, or use the HYP_KEY env var.`,
  alias: 'k',
  default: ENV.HYP_KEY,
};

export const outDirCommandOption: Options = {
  type: 'string',
  description: 'A folder name output artifacts into',
  default: './artifacts',
  alias: 'o',
};

export const coreArtifactsOption: Options = {
  type: 'string',
  description: 'File path to core deployment output artifacts',
  alias: 'a',
};

export const warpConfigOption: Options = {
  type: 'string',
  description: 'File path to Warp config',
  alias: 'w',
};

export const agentConfigCommandOption: Options = {
  type: 'string',
  description: 'File path to agent configuration artifacts',
};

export const fileFormatOption: Options = {
  type: 'string',
  description: 'Output file format',
  choices: ['json', 'yaml'],
  default: 'yaml',
  alias: 'f',
};

export const outputFileOption = (defaultPath: string): Options => ({
  type: 'string',
  description: 'Output file path',
  default: defaultPath,
  alias: 'o',
});

export const skipConfirmationOption: Options = {
  type: 'boolean',
  description: 'Skip confirmation prompts',
  default: false,
  alias: 'y',
};

export const dryRunOption: Options = {
  type: 'boolean',
  description:
    'Simulate deployment on forked network. Please ensure an anvil node instance is running during execution via `anvil`.',
  default: false,
  alias: ['d', 'dr'],
};
