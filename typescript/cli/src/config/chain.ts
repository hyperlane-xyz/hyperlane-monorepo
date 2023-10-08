import { confirm, input, select } from '@inquirer/prompts';
import fs from 'fs';

import {
  ChainMap,
  ChainMetadata,
  ChainMetadataSchema,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { errorRed, log, logBlue, logGreen } from '../../logger.js';
import { getMultiProvider } from '../context.js';
import { FileFormat, mergeYamlOrJson, readYamlOrJson } from '../utils/files.js';

export function readChainConfig(filePath: string) {
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

  for (const [chain, metadata] of Object.entries(chainToMetadata)) {
    const parseResult = ChainMetadataSchema.safeParse(metadata);
    if (!parseResult.success) {
      errorRed(
        `Chain config for ${chain} is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/chain-config.yaml for an example`,
      );
      errorRed(JSON.stringify(parseResult.error.errors));
      process.exit(1);
    }
    if (metadata.name !== chain) {
      errorRed(`Chain ${chain} name does not match key`);
      process.exit(1);
    }
  }

  // Ensure multiprovider accepts this metadata
  getMultiProvider(chainToMetadata);

  logGreen(`All chain configs in ${filePath} are valid`);
  return chainToMetadata;
}

export function readChainConfigIfExists(filePath: string) {
  if (!fs.existsSync(filePath)) {
    log('No chain config file provided');
    return {};
  } else {
    return readChainConfig(filePath);
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
