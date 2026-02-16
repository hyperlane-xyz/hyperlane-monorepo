import { createCoreReader } from '@hyperlane-xyz/deploy-sdk';
import {
  type ChainName,
  type CoreConfig,
  EvmCoreReader,
  altVmChainLookup,
} from '@hyperlane-xyz/sdk';
import { type Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';
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

  const protocolType = context.multiProvider.getProtocol(chain);

  switch (protocolType) {
    case ProtocolType.Ethereum: {
      const evmCoreReader = new EvmCoreReader(context.multiProvider, chain);
      try {
        return await evmCoreReader.deriveCoreConfig({
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
      break;
    }
    default: {
      const chainLookup = altVmChainLookup(context.multiProvider);
      const metadata = chainLookup.getChainMetadata(chain);
      const coreReader = createCoreReader(metadata, chainLookup);
      try {
        return await coreReader.deriveCoreConfig(mailbox);
      } catch (e: any) {
        errorRed(
          `❌ Failed to read core config for mailbox ${mailbox} on ${chain}:`,
          e,
        );
        process.exit(1);
      }
    }
  }
}
