import {
  Address,
  HexString,
  assert,
  ensure0x,
  messageId,
  pollAsync,
} from '@hyperlane-xyz/utils';

import { BaseCosmosAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';

import { ICoreAdapter } from './types.js';

const MESSAGE_DISPATCH_EVENT_TYPE = 'dispatch';
const MESSAGE_ATTRIBUTE_KEY = 'message';
const MESSAGE_DESTINATION_ATTRIBUTE_KEY = 'destination';

export class CosmNativeCoreAdapter
  extends BaseCosmosAdapter
  implements ICoreAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  extractMessageIds(
    sourceTx: TypedTransactionReceipt,
  ): Array<{ messageId: string; destination: ChainName }> {
    if (sourceTx.type !== ProviderType.CosmJsNative) {
      throw new Error(
        `Unsupported provider type for CosmNativeCoreAdapter ${sourceTx.type}`,
      );
    }
    const dispatchEvents = sourceTx.receipt.events.filter(
      (e) => e.type === MESSAGE_DISPATCH_EVENT_TYPE,
    );
    const result: Array<{ messageId: string; destination: ChainName }> = [];
    for (let i = 0; i < dispatchEvents.length; i++) {
      const messageAttribute = dispatchEvents[i].attributes.find(
        (a) => a.key === MESSAGE_ATTRIBUTE_KEY,
      );
      const destAttribute = dispatchEvents[i].attributes.find(
        (a) => a.key === MESSAGE_DESTINATION_ATTRIBUTE_KEY,
      );
      assert(messageAttribute, 'No message attribute found in dispatch event');
      assert(destAttribute, 'No destination attribute found in dispatch event');
      result.push({
        messageId: ensure0x(messageId(messageAttribute.value)),
        destination: this.multiProvider.getChainName(destAttribute.value),
      });
    }
    return result;
  }

  async waitForMessageProcessed(
    messageId: HexString,
    destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<boolean> {
    const provider = await this.multiProvider.getCosmJsNativeProvider(
      destination,
    );

    await pollAsync(
      async () => {
        this.logger.debug(`Checking if message ${messageId} was processed`);
        const { delivered } = await provider.query.core.Delivered({
          id: this.addresses.mailbox,
          message_id: messageId,
        });

        if (!delivered) {
          throw new Error(`Message ${messageId} not yet processed`);
        }

        this.logger.info(`Message ${messageId} was processed`);
        return delivered;
      },
      delayMs,
      maxAttempts,
    );

    return true;
  }
}
