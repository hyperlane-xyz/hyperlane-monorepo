import { Address, HexString } from '@hyperlane-xyz/utils';

import { BaseStarknetAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';
import {
  getStarknetMailboxContract,
  parseStarknetDispatchEvents,
} from '../../utils/starknet.js';

import { ICoreAdapter } from './types.js';

export class StarknetCoreAdapter
  extends BaseStarknetAdapter
  implements ICoreAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  extractMessageIds(
    sourceTx: TypedTransactionReceipt,
  ): Array<{ messageId: string; destination: ChainName }> {
    if (sourceTx.type !== ProviderType.Starknet) {
      throw new Error(
        `Unsupported provider type for StarknetCoreAdapter ${sourceTx.type}`,
      );
    }

    const mailboxContract = getStarknetMailboxContract(
      this.addresses.mailbox,
      this.getProvider(),
    );

    const parsedEvents = mailboxContract.parseEvents(sourceTx.receipt);
    const messages = parseStarknetDispatchEvents(
      parsedEvents,
      (domain) => this.multiProvider.tryGetChainName(domain) ?? undefined,
    );

    return messages.map(({ id, parsed }) => ({
      messageId: id,
      destination: this.multiProvider.getChainName(parsed.destination),
    }));
  }

  async waitForMessageProcessed(
    messageId: HexString,
    destination: ChainName,
    delayMs = 5000,
    maxAttempts = 60,
  ): Promise<boolean> {
    const destAdapter = new StarknetCoreAdapter(
      destination,
      this.multiProvider,
      { mailbox: this.addresses.mailbox },
    );

    const mailboxContract = getStarknetMailboxContract(
      destAdapter.addresses.mailbox,
      destAdapter.getProvider(),
    );

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Check if the message has been delivered
        const isDelivered = await mailboxContract.call('delivered', [
          messageId,
        ]);

        if (isDelivered) {
          this.logger.debug(
            `Message ${messageId} confirmed delivered on ${destination}`,
          );
          return true;
        }
      } catch (error) {
        this.logger.error(
          `Error checking if message ${messageId} is delivered: ${error}`,
        );
      }

      this.logger.debug(
        `Message ${messageId} not yet delivered on ${destination}, waiting ${delayMs}ms`,
      );

      // Wait before checking again
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    this.logger.warn(
      `Timed out waiting for message ${messageId} to be delivered on ${destination}`,
    );
    return false;
  }
}
