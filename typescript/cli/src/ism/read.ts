import { ChainName, EvmIsmReader } from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { readChainConfigsIfExists } from '../config/chain.js';
import { getMultiProvider } from '../context.js';
import { log, logBlue, logRed } from '../logger.js';
import { FileFormat, writeFileAtPath } from '../utils/files.js';

/**
 * Read ISM config for a specified chain and address, logging or writing result to file.
 */
export async function readIsmConfig({
  chain,
  address,
  chainConfigPath,
  concurrency = 20,
  format,
  output,
}: {
  chain: ChainName;
  address: Address;
  chainConfigPath: string;
  concurrency: number;
  format: FileFormat;
  output?: string;
}): Promise<void> {
  const customChains = readChainConfigsIfExists(chainConfigPath);
  const multiProvider = getMultiProvider(customChains);

  // output file format overrides provided format
  format = output?.endsWith('.json')
    ? 'json'
    : output?.endsWith('.yaml')
    ? 'yaml'
    : format;

  if (
    multiProvider.getChainMetadata(chain).protocol === ProtocolType.Ethereum
  ) {
    const ismReader = new EvmIsmReader(multiProvider, chain, concurrency);
    const config = await ismReader.deriveIsmConfig(address);
    const stringConfig = EvmIsmReader.stringifyConfig(config, 2, format);
    if (!output) {
      logBlue(`ISM Config at ${address} on ${chain}:`);
      log(stringConfig);
    } else {
      writeFileAtPath(output, stringConfig + '\n');
      logBlue(`ISM Config written to ${output}.`);
    }
    return;
  }

  logRed('Unsupported chain. Currently this command supports EVM chains only.');
}
