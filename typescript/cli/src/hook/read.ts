import { ChainName, EvmHookReader } from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, stringifyObject } from '@hyperlane-xyz/utils';

import { readChainConfigsIfExists } from '../config/chain.js';
import { getMultiProvider } from '../context.js';
import { log, logBlue, logRed } from '../logger.js';
import {
  FileFormat,
  resolveFileFormat,
  writeFileAtPath,
} from '../utils/files.js';

/**
 * Read Hook config for a specified chain and address, logging or writing result to file.
 */
export async function readHookConfig({
  chain,
  address,
  chainConfigPath,
  format,
  output,
}: {
  chain: ChainName;
  address: Address;
  chainConfigPath: string;
  format: FileFormat;
  output?: string;
}): Promise<void> {
  const customChains = readChainConfigsIfExists(chainConfigPath);
  const multiProvider = getMultiProvider(customChains);

  if (multiProvider.getProtocol(chain) === ProtocolType.Ethereum) {
    const hookReader = new EvmHookReader(multiProvider, chain);
    const config = await hookReader.deriveHookConfig(address);
    const stringConfig = stringifyObject(
      config,
      resolveFileFormat(output, format),
      2,
    );
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
