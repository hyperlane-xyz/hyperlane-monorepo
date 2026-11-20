import {
  CallData,
  InvokeTransactionReceiptResponse,
  ParsedEvents,
  createAbiParser,
  events as eventsUtils,
} from 'starknet';

import { getContractAbi } from '@hyperlane-xyz/starknet-core/runtime';
import { Address, HexString, pollAsync } from '@hyperlane-xyz/utils';

import { BaseStarknetAdapter } from '../../app/MultiProtocolApp.js';
import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import {
  ProviderType,
  StarknetJsTransactionReceipt,
} from '../../providers/ProviderType.js';
import { defaultStarknetJsProviderBuilder } from '../../providers/builders/starknet.js';
import { ChainName } from '../../types.js';
import { parseCustomRpcHeaders } from '../../utils/provider.js';
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
    public readonly multiProvider: MultiProviderAdapter,
    public readonly addresses: { mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async extractMessageIds(
    sourceTx: StarknetJsTransactionReceipt,
  ): Promise<Array<{ messageId: string; destination: ChainName }>> {
    if (sourceTx.type !== ProviderType.Starknet) {
      throw new Error(
        `Unsupported provider type for StarknetCoreAdapter ${sourceTx.type}`,
      );
    }

    let parsedEvents: ParsedEvents = [];
    sourceTx.receipt.match({
      SUCCEEDED: (txR) => {
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
        const mailboxAbi = getContractAbi('mailbox');
        parsedEvents = eventsUtils.parseEvents(
          emittedEvents,
          eventsUtils.getAbiEvents(mailboxAbi),
          CallData.getAbiStruct(mailboxAbi),
          CallData.getAbiEnum(mailboxAbi),
          createAbiParser(mailboxAbi),
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

    await pollAsync(
      async () => {
        const isDelivered = await destAdapter.isDelivered(messageId);

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

  async isDelivered(
    messageId: HexString,
    _blockTag?: string | number,
  ): Promise<boolean> {
    const primary = this.getProvider();
    const metadata = this.multiProvider.getChainMetadata(this.chainName);
    const [first, ...alternates] = metadata.rpcUrls;
    // Keep a caller-supplied RPC (for example, a local fork) isolated.
    const fallbacks =
      first && primary.channel.nodeUrl === parseCustomRpcHeaders(first.http).url
        ? alternates
        : [];
    let provider = primary;
    for (let index = 0; ; index++) {
      const mailbox = getStarknetMailboxContract(
        this.addresses.mailbox,
        provider,
      );
      try {
        return Boolean(await mailbox.call('delivered', [messageId]));
      } catch (error) {
        const rpc = fallbacks[index];
        if (!rpc) throw error;
        this.logger.debug(
          { chain: this.chainName },
          'Retrying delivery read on the next Starknet RPC',
        );
        provider = defaultStarknetJsProviderBuilder({
          ...metadata,
          rpcUrls: [rpc],
        }).provider;
      }
    }
  }
}
