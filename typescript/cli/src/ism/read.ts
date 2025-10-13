import {
  AltVMIsmReader,
  ChainName,
  DerivedIsmConfig,
  EvmIsmReader,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, stringifyObject } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { log, logBlue } from '../logger.js';
import { resolveFileFormat, writeFileAtPath } from '../utils/files.js';

/**
 * Read ISM config for a specified chain and address, logging or writing result to file.
 */
export async function readIsmConfig({
  context,
  chain,
  address,
  out,
}: {
  context: CommandContext;
  chain: ChainName;
  address: Address;
  out?: string;
}): Promise<void> {
  let config: DerivedIsmConfig;
  let stringConfig: string;

  if (context.multiProvider.getProtocol(chain) === ProtocolType.Ethereum) {
    const ismReader = new EvmIsmReader(context.multiProvider, chain);
    config = await ismReader.deriveIsmConfig(address);
    stringConfig = stringifyObject(config, resolveFileFormat(out), 2);
  } else {
    const provider = await context.altVmProvider.get(chain);
    const ismReader = new AltVMIsmReader(context.multiProvider, provider);
    config = await ismReader.deriveIsmConfig(address);
    stringConfig = stringifyObject(config, resolveFileFormat(out), 2);
  }

  if (!out) {
    logBlue(`ISM Config at ${address} on ${chain}:`);
    log(stringConfig);
  } else {
    writeFileAtPath(out, stringConfig + '\n');
    logBlue(`ISM Config written to ${out}.`);
  }
}
