import { confirm, input, select } from '@inquirer/prompts';

import { ChainMetadata, isValidChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { errorRed, logBlue, logGreen } from '../logger.js';
import { FileFormat, mergeYamlOrJson } from '../utils/files.js';

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
  if (isValidChainMetadata(metadata)) {
    logGreen(`Chain config is valid, writing to file ${outPath}`);
    mergeYamlOrJson(outPath, { [name]: metadata }, format);
  } else {
    errorRed(
      `Chain config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/chain-config.yaml for an example`,
    );
    throw new Error('Invalid chain config');
  }
}
