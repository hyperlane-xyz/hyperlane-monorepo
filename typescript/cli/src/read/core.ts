import { ChainName, CoreConfig, EvmCoreReader } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed } from '../logger.js';

export async function executeCoreRead({
  context,
  chain,
  mailbox,
}: {
  context: CommandContext;
  chain: ChainName;
  mailbox?: Address;
}): Promise<CoreConfig> {
  if (!mailbox) {
    const addresses = await context.registry.getChainAddresses(chain);
    mailbox = addresses?.mailbox;
    if (!mailbox) {
      errorRed(`${chain} mailbox not provided and none found in registry.`);
      process.exit(1);
    }
  }

  const evmCoreReader = new EvmCoreReader(context.multiProvider, chain);
  try {
    return evmCoreReader.deriveCoreConfig(mailbox);
  } catch (e: any) {
    errorRed(
      `❌ Failed to read core config for mailbox ${mailbox} on ${chain}:`,
      e,
    );
    process.exit(1);
  }
}
