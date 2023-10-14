// A set of common options
import { Options } from 'yargs';

export const keyCommandOption: Options = {
  type: 'string',
  description:
    'A hex private key or seed phrase for transaction signing. Or use the HYP_KEY env var',
};

export const chainsCommandOption: Options = {
  type: 'string',
  description: 'A path to a JSON or YAML file with chain configs',
  default: './configs/chain-config.yaml',
};

export const outDirCommandOption: Options = {
  type: 'string',
  description: 'A folder name output artifacts into',
  default: './artifacts',
};

export const coreArtifactsOption: Options = {
  type: 'string',
  description: 'File path to core deployment output artifacts',
};

export const fileFormatOption: Options = {
  type: 'string',
  alias: 'f',
  description: 'Output file format',
  choices: ['json', 'yaml'],
  default: 'yaml',
};

export const outputFileOption = (defaultPath: string): Options => ({
  type: 'string',
  alias: 'o',
  description: 'Output file path',
  default: defaultPath,
});

export const skipConfirmationOption: Options = {
  type: 'boolean',
  alias: 'y',
  description: 'Skip confirmation prompts',
  default: false,
};
