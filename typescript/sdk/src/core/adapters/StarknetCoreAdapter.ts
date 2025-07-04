import {
  CallData,
  InvokeTransactionReceiptResponse,
  ParsedEvents,
  events as eventsUtils,
} from 'starknet';

import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { Address, HexString, pollAsync } from '@hyperlane-xyz/utils';

import { BaseStarknetAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import {
  ProviderType,
  StarknetJsTransactionReceipt,
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
    sourceTx: StarknetJsTransactionReceipt,
  ): Array<{ messageId: string; destination: ChainName }> {
    if (sourceTx.type !== ProviderType.Starknet) {
      throw new Error(
        `Unsupported provider type for StarknetCoreAdapter ${sourceTx.type}`,
      );
    }

    let parsedEvents: ParsedEvents = [];
    sourceTx.receipt.match({
      success: (txR) => {
        const emittedEvents =
          (txR as InvokeTransactionReceiptResponse).events?.map((event) => {
            return {
              block_hash: (txR as any).block_hash,
              block_number: (txR as any).block_number,
              transaction_hash: (txR as any).transaction_hash,
              ...event,
            };
          }) || [];

        if (emittedEvents.length === 0) return;
        const mailboxAbi = getCompiledContract('mailbox').abi;
        parsedEvents = eventsUtils.parseEvents(
          emittedEvents,
          eventsUtils.getAbiEvents(mailboxAbi),
          CallData.getAbiStruct(mailboxAbi),
          CallData.getAbiEnum(mailboxAbi),
        );
      },
      _: () => {
        throw Error('This transaction was not successful.');
      },
    });

    if (!parsedEvents || parsedEvents.length === 0) return [];

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

    await pollAsync(
      async () => {
        const isDelivered = await mailboxContract.call('delivered', [
          messageId,
        ]);

        if (!isDelivered) {
          throw new Error(
            `Message ${messageId} not yet delivered on ${destination}`,
          );
        }

        this.logger.debug(
          `Message ${messageId} confirmed delivered on ${destination}`,
        );

        return isDelivered;
      },
      delayMs,
      maxAttempts,
    );

    return true;
  }
}
