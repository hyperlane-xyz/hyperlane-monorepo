import { AltVMHookReader } from '@hyperlane-xyz/deploy-sdk';
import { ChainName, EvmHookReader } from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  mustGet,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { log, logBlue } from '../logger.js';
import { resolveFileFormat, writeFileAtPath } from '../utils/files.js';

/**
 * Read Hook config for a specified chain and address, logging or writing result to file.
 */
export async function readHookConfig({
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
  const protocol = context.multiProvider.getProtocol(chain);
  switch (protocol) {
    case ProtocolType.Ethereum: {
      const hookReader = new EvmHookReader(context.multiProvider, chain);
      const config = await hookReader.deriveHookConfig(address);
      const stringConfig = stringifyObject(config, resolveFileFormat(out), 2);
      if (!out) {
        logBlue(`Hook Config at ${address} on ${chain}:`);
        log(stringConfig);
      } else {
        writeFileAtPath(out, stringConfig + '\n');
        logBlue(`Hook Config written to ${out}.`);
      }
      break;
    }
    default: {
      const provider = mustGet(context.altVmProviders, chain);
      const hookReader = new AltVMHookReader(
        (chain) => context.multiProvider.getChainMetadata(chain),
        provider,
      );
      const config = await hookReader.deriveHookConfig(address);
      const stringConfig = stringifyObject(config, resolveFileFormat(out), 2);
      if (!out) {
        logBlue(`Hook Config at ${address} on ${chain}:`);
        log(stringConfig);
      } else {
        writeFileAtPath(out, stringConfig + '\n');
        logBlue(`Hook Config written to ${out}.`);
      }
    }
  }
}
