import {
  ChainMap,
  ChainMetadata,
  isValidChainMetadata,
} from '@hyperlane-xyz/sdk';

import { errorRed, logGreen } from '../logger.js';
import { readYamlOrJson } from '../utils/files.js';
import { getMultiProvider } from '../utils/providers.js';

export function readChainConfig(filepath: string) {
  console.log(`Reading file configs in ${filepath}`);
  const chainToMetadata = readYamlOrJson<ChainMap<ChainMetadata>>(filepath);

  if (
    !chainToMetadata ||
    typeof chainToMetadata !== 'object' ||
    !Object.keys(chainToMetadata).length
  ) {
    errorRed(`No configs found in ${filepath}`);
    process.exit(1);
  }

  for (const [chain, metadata] of Object.entries(chainToMetadata)) {
    if (!isValidChainMetadata(metadata)) {
      errorRed(`Chain ${chain} has invalid metadata`);
      errorRed(
        `Chain config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/chain-config.yaml for an example`,
      );
      process.exit(1);
    }
    if (metadata.name !== chain) {
      errorRed(`Chain ${chain} name does not match key`);
      process.exit(1);
    }
  }

  // Ensure multiprovider accepts this metadata
  getMultiProvider(chainToMetadata);

  logGreen(`All chain configs in ${filepath} are valid`);
  return chainToMetadata;
}
