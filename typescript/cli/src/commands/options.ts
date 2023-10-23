// A set of common options
import { Options } from 'yargs';

export const keyCommandOption: Options = {
  type: 'string',
  description:
    'A hex private key or seed phrase for transaction signing. Or use the HYP_KEY env var',
  alias: 'k',
};

export const chainsCommandOption: Options = {
  type: 'string',
  description: 'A path to a JSON or YAML file with chain configs',
  default: './configs/chain-config.yaml',
  alias: 'cc',
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
  alias: 'ca',
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
