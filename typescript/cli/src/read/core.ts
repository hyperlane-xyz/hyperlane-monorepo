import {
  ChainName,
  DerivedCoreConfig,
  EvmCoreReader,
  StarknetCoreReader,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

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
}): Promise<DerivedCoreConfig> {
  const addresses = await context.registry.getChainAddresses(chain);
  if (!mailbox) {
    mailbox = addresses?.mailbox;

    assert(
      mailbox,
      `${chain} mailbox not provided and none found in registry.`,
    );
  }

  const protocol = context.multiProvider.getProtocol(chain);
  if (protocol === ProtocolType.Ethereum) {
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
  } else if (protocol === ProtocolType.Starknet) {
    assert(context.multiProtocolProvider, 'Starknet provider not found');
    const starknetCoreReader = new StarknetCoreReader(
      context.multiProtocolProvider,
      chain,
    );
    return starknetCoreReader.deriveCoreConfig(mailbox);
  }

  throw new Error(`Unsupported protocol: ${protocol}`);
}
