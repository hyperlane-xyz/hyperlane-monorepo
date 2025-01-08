import { ChainName, CoreConfig, EvmCoreReader } from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

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
  const addresses = await context.registry.getChainAddresses(chain);
  if (!mailbox) {
    mailbox = addresses?.mailbox;

    assert(
      mailbox,
      `${chain} mailbox not provided and none found in registry.`,
    );
  }

  const evmCoreReader = new EvmCoreReader(context.multiProvider, chain);
  try {
    return evmCoreReader.deriveCoreConfig({
      mailbox,
      interchainAccountRouter: addresses?.interchainAccountRouter,
    });
  } catch (e: any) {
    errorRed(
      `❌ Failed to read core config for mailbox ${mailbox} on ${chain}:`,
      e,
    );
    process.exit(1);
  }
}
