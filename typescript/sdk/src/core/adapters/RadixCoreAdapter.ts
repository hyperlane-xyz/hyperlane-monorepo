import {
  Address,
  HexString,
  assert,
  ensure0x,
  messageId,
  pollAsync,
} from '@hyperlane-xyz/utils';

import { BaseRadixAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';

import { ICoreAdapter } from './types.js';

const MESSAGE_DISPATCH_EVENT_TYPE = 'DispatchEvent';
const MESSAGE_FIELD_KEY = 'message';
const MESSAGE_DESTINATION_FIELD_KEY = 'destination';

export class RadixCoreAdapter extends BaseRadixAdapter implements ICoreAdapter {
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
    assert(
      sourceTx.type === ProviderType.Radix,
      `Unsupported provider type for RadixCoreAdapter ${sourceTx.type}`,
    );

    const events = sourceTx.receipt.transaction.receipt?.events ?? [];
    if (events.length === 0) {
      return [];
    }

    const dispatchEvents = events.filter(
      (e) => e.name === MESSAGE_DISPATCH_EVENT_TYPE,
    );

    return dispatchEvents.map((event) => {
      const findField = (key: string) =>
        ((event.data as any)?.fields ?? []).find(
          (f: any) => f.field_name === key,
        );

      const messageField = findField(MESSAGE_FIELD_KEY);
      const destField = findField(MESSAGE_DESTINATION_FIELD_KEY);

      assert(messageField, 'No message field found in dispatch event');
      assert(destField, 'No destination field found in dispatch event');

      return {
        messageId: ensure0x(messageId(ensure0x(messageField.hex))),
        destination: this.multiProvider.getChainName(destField.value),
      };
    });
  }

  async waitForMessageProcessed(
    messageId: HexString,
    destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<boolean> {
    const provider = this.multiProvider.getRadixProvider(destination);

    await pollAsync(
      async () => {
        this.logger.debug(`Checking if message ${messageId} was processed`);
        const delivered = await provider.isMessageDelivered({
          mailboxAddress: this.addresses.mailbox,
          messageId: messageId,
        });

        assert(delivered, `Message ${messageId} not yet processed`);

        this.logger.info(`Message ${messageId} was processed`);
        return delivered;
      },
      delayMs,
      maxAttempts,
    );

    return true;
  }
}
