// A set of common options
import { Options } from 'yargs';

export const keyCommandOption: Options = {
  type: 'string',
  description:
    'A hex private key or seed phrase for transaction signing. Or use the HYP_KEY env var',
};

export const chainsCommandOption: Options = {
  type: 'string',
  description: 'A path to a JSON or YAML file with chain configs.',
  default: './configs/chain-config.yaml',
};

export const outDirCommandOption: Options = {
  type: 'string',
  description: 'A folder name output artifacts into.',
  default: './artifacts',
};
