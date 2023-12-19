import { input } from '@inquirer/prompts';

import {
  ChainMap,
  ChainMetadata,
  ChainMetadataSchema,
  chainMetadata as coreChainMetadata,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMerge } from '@hyperlane-xyz/utils';

import { errorRed, log, logBlue, logGreen } from '../../logger.js';
import { getMultiProvider } from '../context.js';
import {
  FileFormat,
  isFile,
  mergeYamlOrJson,
  readYamlOrJson,
} from '../utils/files.js';

export function readChainConfigs(filePath: string) {
  log(`Reading file configs in ${filePath}`);
  const chainToMetadata = readYamlOrJson<ChainMap<ChainMetadata>>(filePath);

  if (
    !chainToMetadata ||
    typeof chainToMetadata !== 'object' ||
    !Object.keys(chainToMetadata).length
  ) {
    errorRed(`No configs found in ${filePath}`);
    process.exit(1);
  }

  // Validate configs from file and merge in core configs as needed
  for (const chain of Object.keys(chainToMetadata)) {
    if (coreChainMetadata[chain]) {
      // For core chains, merge in the default config to allow users to override only some fields
      chainToMetadata[chain] = objMerge(
        coreChainMetadata[chain],
        chainToMetadata[chain],
      );
    }
    const parseResult = ChainMetadataSchema.safeParse(chainToMetadata[chain]);
    if (!parseResult.success) {
      errorRed(
        `Chain config for ${chain} is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/chain-config.yaml for an example`,
      );
      errorRed(JSON.stringify(parseResult.error.errors));
      process.exit(1);
    }
    if (chainToMetadata[chain].name !== chain) {
      errorRed(`Chain ${chain} name does not match key`);
      process.exit(1);
    }
  }

  // Ensure MultiProvider accepts this metadata
  getMultiProvider(chainToMetadata);

  logGreen(`All chain configs in ${filePath} are valid`);
  return chainToMetadata;
}

export function readChainConfigsIfExists(filePath?: string) {
  if (!filePath || !isFile(filePath)) {
    log('No chain config file provided');
    return {};
  } else {
    return readChainConfigs(filePath);
  }
}

export async function createChainConfig({
  format,
  outPath,
}: {
  format: FileFormat;
  outPath: string;
}) {
  logBlue('Creating a new chain config');
  const name = await input({
    message: 'Enter chain name (one word, lower case)',
  });
  const chainId = await input({ message: 'Enter chain id (number)' });
  const domainId = chainId;
  const rpcUrl = await input({ message: 'Enter http or https rpc url' });
  const metadata: ChainMetadata = {
    name,
    chainId: parseInt(chainId, 10),
    domainId: parseInt(domainId, 10),
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: rpcUrl }],
  };
  const parseResult = ChainMetadataSchema.safeParse(metadata);
  if (parseResult.success) {
    logGreen(`Chain config is valid, writing to file ${outPath}`);
    mergeYamlOrJson(outPath, { [name]: metadata }, format);
  } else {
    errorRed(
      `Chain config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/chain-config.yaml for an example`,
    );
    errorRed(JSON.stringify(parseResult.error.errors));
    throw new Error('Invalid chain config');
  }
}
