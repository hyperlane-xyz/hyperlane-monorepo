import { AltVmIsmReader, ChainName, EvmIsmReader } from '@hyperlane-xyz/sdk';
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
  switch (context.multiProvider.getProtocol(chain)) {
    case ProtocolType.Ethereum: {
      const ismReader = new EvmIsmReader(context.multiProvider, chain);
      const config = await ismReader.deriveIsmConfig(address);
      const stringConfig = stringifyObject(config, resolveFileFormat(out), 2);
      if (!out) {
        logBlue(`ISM Config at ${address} on ${chain}:`);
        log(stringConfig);
      } else {
        writeFileAtPath(out, stringConfig + '\n');
        logBlue(`ISM Config written to ${out}.`);
      }
      break;
    }
    default: {
      const provider = await context.altVmProvider.get(chain);
      const ismReader = new AltVmIsmReader(context.multiProvider, provider);
      const config = await ismReader.deriveIsmConfig(address);
      const stringConfig = stringifyObject(config, resolveFileFormat(out), 2);
      if (!out) {
        logBlue(`ISM Config at ${address} on ${chain}:`);
        log(stringConfig);
      } else {
        writeFileAtPath(out, stringConfig + '\n');
        logBlue(`ISM Config written to ${out}.`);
      }
    }
  }
}
