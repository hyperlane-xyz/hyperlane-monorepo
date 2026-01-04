import os from 'os';
import { Options } from 'yargs';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { LogFormat, LogLevel } from '@hyperlane-xyz/utils';

import { ENV } from '../utils/env.js';

const defineOption = <O extends Options>(option: O) => option;

const logFormatChoices = Object.values(LogFormat) as ReadonlyArray<LogFormat>;
const logLevelChoices = Object.values(LogLevel) as ReadonlyArray<LogLevel>;

/* Global options */

export const DEFAULT_LOCAL_REGISTRY = `${os.homedir()}/.hyperlane`;

export const demandOption = <O extends Options>(option: O) =>
  defineOption({
    ...option,
    demandOption: true as const,
  });

export const logFormatCommandOption = defineOption({
  type: 'string',
  description: 'Log output format',
  choices: logFormatChoices,
});

export const logLevelCommandOption = defineOption({
  type: 'string',
  description: 'Log verbosity level',
  choices: logLevelChoices,
});

export const registryUrisCommandOption = defineOption({
  type: 'array',
  string: true,
  description:
    'List of Github or local path registries, later registry takes priority over previous',
  alias: 'r',
  default: [DEFAULT_GITHUB_REGISTRY, DEFAULT_LOCAL_REGISTRY],
});

export const githubAuthTokenOption = defineOption({
  type: 'string',
  description: 'Github auth token for accessing registry repository',
  default: ENV.GH_AUTH_TOKEN,
  defaultDescription: 'process.env.GH_AUTH_TOKEN',
});

export const overrideRegistryUriCommandOption = defineOption({
  type: 'string',
  description: 'Path to a local registry to override the default registry',
  default: '',
  hidden: true,
});

export const skipConfirmationOption = defineOption({
  type: 'boolean',
  description: 'Skip confirmation prompts',
  default: false,
  alias: 'y',
});

export const keyCommandOption = defineOption({
  type: 'string',
  description:
    'A hex private key or seed phrase for transaction signing, or use the HYP_KEY env var. Use --key.{protocol} or HYP_KEY_{PROTOCOL} for chain specific key inputs',
  alias: ['k', 'private-key', 'seed-phrase'],
  default: ENV.HYP_KEY,
  defaultDescription: 'process.env.HYP_KEY',
});

export const disableProxyCommandOption = defineOption({
  type: 'boolean',
  description:
    'Disable routing of Github API requests through the Hyperlane registry proxy.',
  default: false,
});

/* Command-specific options */

export const coreTargetsCommandOption = defineOption({
  type: 'string',
  description:
    'Comma separated list of chain names to which contracts will be deployed',
});

export const agentTargetsCommandOption = defineOption({
  type: 'string',
  description: 'Comma separated list of chains to relay between',
});

export const originCommandOption = defineOption({
  type: 'string',
  description: 'The name of the origin chain to deploy to',
});

export const ismCommandOption = defineOption({
  type: 'string',
  description:
    'A path to a JSON or YAML file with basic or advanced ISM configs (e.g. Multisig)',
});

export const hookCommandOption = defineOption({
  type: 'string',
  description:
    'A path to a JSON or YAML file with Hook configs (for every chain)',
});

export const DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH =
  './configs/warp-route-deployment.yaml';

export const DEFAULT_CORE_DEPLOYMENT_CONFIG_PATH = './configs/core-config.yaml';
export const DEFAULT_STRATEGY_CONFIG_PATH = `${os.homedir()}/.hyperlane/strategies/default-strategy.yaml`;

export const warpDeploymentConfigCommandOption = defineOption({
  type: 'string',
  description:
    'A path to a JSON or YAML file with a warp route deployment config.',
  demandOption: false,
  alias: 'wd',
});

export const warpCoreConfigCommandOption = defineOption({
  type: 'string',
  description: 'File path to Warp Route config',
  alias: 'wc',
});

export const agentConfigCommandOption = (isIn: boolean, defaultPath?: string) =>
  defineOption({
    type: 'string',
    description: `${
      isIn ? 'Input' : 'Output'
    } file path for the agent configuration`,
    default: defaultPath,
  });

export const chainTargetsCommandOption = defineOption({
  type: 'string',
  description: 'Comma-separated list of chain names',
  alias: 'c',
});

export const outputFileCommandOption = (
  defaultPath?: string,
  demandOption = false,
  description = 'Output file path',
) =>
  defineOption({
    type: 'string',
    description,
    default: defaultPath,
    alias: 'o',
    demandOption,
  });

interface InputFileCommandOptionConfig
  extends Pick<Options, 'demandOption' | 'alias' | 'description'> {
  defaultPath?: string;
}

export const inputFileCommandOption = ({
  defaultPath,
  demandOption = true,
  description = 'Input file path',
  alias = 'i',
}: InputFileCommandOptionConfig = {}) =>
  defineOption({
    type: 'string',
    description,
    default: defaultPath,
    alias,
    demandOption,
  });

export const fromAddressCommandOption = defineOption({
  type: 'string',
  description: `An address to simulate transaction signing on a forked network`,
  alias: 'f',
});

export const chainCommandOption = defineOption({
  type: 'string',
  description: 'The specific chain to perform operations with.',
});

export const symbolCommandOption = defineOption({
  type: 'string',
  description: 'Token symbol (e.g. ETH, USDC)',
});

export const validatorCommandOption = defineOption({
  type: 'string',
  description: 'Comma separated list of validator addresses',
  demandOption: true,
});

export const transactionsCommandOption = defineOption({
  type: 'string',
  description: 'The transaction input file path.',
  alias: ['t', 'txs', 'txns'],
  demandOption: true,
});

export const strategyCommandOption = defineOption({
  type: 'string',
  description: 'The submission strategy input file path.',
  alias: ['s', 'strategy'],
  demandOption: false,
});

export const addressCommandOption = (
  description: string,
  demandOption = false,
) =>
  defineOption({
    type: 'string',
    description,
    demandOption,
  });

/* Validator options */
export const awsAccessKeyCommandOption = defineOption({
  type: 'string',
  description: 'AWS access key of IAM user associated with validator',
  default: ENV.AWS_ACCESS_KEY_ID,
  defaultDescription: 'process.env.AWS_ACCESS_KEY_ID',
});

export const awsSecretKeyCommandOption = defineOption({
  type: 'string',
  description: 'AWS secret access key of IAM user associated with validator',
  default: ENV.AWS_SECRET_ACCESS_KEY,
  defaultDescription: 'process.env.AWS_SECRET_ACCESS_KEY',
});

export const awsRegionCommandOption = defineOption({
  type: 'string',
  describe: 'AWS region associated with validator',
  default: ENV.AWS_REGION,
  defaultDescription: 'process.env.AWS_REGION',
});

export const awsBucketCommandOption = defineOption({
  type: 'string',
  describe: 'AWS S3 bucket containing validator signatures and announcement',
});

export const awsKeyIdCommandOption = defineOption({
  type: 'string',
  describe: 'Key ID from AWS KMS',
});

export const operatorKeyPathCommandOption = defineOption({
  type: 'string',
  description: 'Path to the operator key file',
});

export const avsChainCommandOption = defineOption({
  type: 'string',
  description: 'Chain to interact with the AVS on',
  demandOption: true,
  choices: ['ethereum'] as const,
});

export const warpRouteIdCommandOption = defineOption({
  type: 'string',
  description: 'Warp route ID to specify the warp route',
  alias: 'id',
});

export const forkCommandOptions = {
  port: defineOption({
    type: 'number',
    description:
      'Port to be used as initial port from which assign port numbers to all anvil instances',
    default: 8545,
  }),
  'fork-config': defineOption({
    type: 'string',
    description:
      'The path to a configuration file that specifies how to build the forked chains',
  }),
  kill: defineOption({
    type: 'boolean',
    default: false,
    description:
      'If set, it will stop the forked chains once the forked config has been applied',
  }),
} satisfies Record<string, Options>;
