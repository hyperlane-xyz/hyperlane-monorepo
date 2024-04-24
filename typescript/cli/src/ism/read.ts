import { ChainName, EvmIsmReader } from '@hyperlane-xyz/sdk';
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
 * Read ISM config for a specified chain and address, logging or writing result to file.
 */
export async function readIsmConfig({
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
    const ismReader = new EvmIsmReader(multiProvider, chain);
    const config = await ismReader.deriveIsmConfig(address);
    const stringConfig = stringifyObject(
      config,
      resolveFileFormat(output, format),
      2,
    );
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
