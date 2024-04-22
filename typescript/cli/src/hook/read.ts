import { ChainName, EvmHookReader } from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { readChainConfigsIfExists } from '../config/chain.js';
import { getMultiProvider } from '../context.js';
import { log, logBlue, logRed } from '../logger.js';
import { FileFormat, writeFileAtPath } from '../utils/files.js';

/**
 * Read Hook config for a specified chain and address, logging or writing result to file.
 */
export async function readHookConfig({
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
    const hookReader = new EvmHookReader(multiProvider, chain, concurrency);
    const config = await hookReader.deriveHookConfig(address);
    const stringConfig = EvmHookReader.stringifyConfig(config, 2, format);
    if (!output) {
      logBlue(`Hook Config at ${address} on ${chain}:`);
      log(stringConfig);
    } else {
      writeFileAtPath(output, stringConfig + '\n');
      logBlue(`Hook Config written to ${output}.`);
    }
    return;
  }

  logRed('Unsupported chain. Currently this command supports EVM chains only.');
}
