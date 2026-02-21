import { TestMailbox, TestMailbox__factory } from '@hyperlane-xyz/core';
import { messageId } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { ChainName } from '../types.js';

import { HyperlaneCore } from './HyperlaneCore.js';
import { coreFactories } from './contracts.js';

export const testCoreFactories = {
  ...coreFactories,
  mailbox: new TestMailbox__factory(),
};

type ProcessTxResponse = Awaited<ReturnType<TestMailbox['process']>>;

export class TestCoreApp extends HyperlaneCore {
  getContracts(chain: ChainName): HyperlaneContracts<typeof testCoreFactories> {
    return super.getContracts(chain) as HyperlaneContracts<
      typeof testCoreFactories
    >;
  }

  async processMessages(): Promise<
    Map<ChainName, Map<ChainName, ProcessTxResponse[]>>
  > {
    const responses = new Map();
    for (const origin of this.chains()) {
      const outbound = await this.processOutboundMessages(origin);
      const originResponses = new Map();
      const remoteChains = await this.remoteChains(origin);
      remoteChains.forEach((destination) =>
        originResponses.set(destination, outbound.get(destination)),
      );
      responses.set(origin, originResponses);
    }
    return responses;
  }

  async processOutboundMessages(
    origin: ChainName,
  ): Promise<Map<ChainName, ProcessTxResponse[]>> {
    const responses = new Map<ChainName, any>();
    const contracts = this.getContracts(origin);
    const outbox = contracts.mailbox as TestMailbox;

    const dispatchFilter = outbox.filters.Dispatch();
    const dispatches = await outbox.queryFilter(dispatchFilter);
    for (const dispatch of dispatches) {
      const dispatchArgs = dispatch.args as unknown;
      const argsObject =
        dispatchArgs && typeof dispatchArgs === 'object'
          ? (dispatchArgs as { destination?: unknown; message?: unknown })
          : undefined;
      const destinationRaw = Array.isArray(dispatchArgs)
        ? dispatchArgs[1]
        : argsObject?.destination;
      const messageRaw = Array.isArray(dispatchArgs)
        ? dispatchArgs[3]
        : argsObject?.message;
      if (destinationRaw === undefined || messageRaw === undefined) {
        continue;
      }
      const destination = Number(BigInt(String(destinationRaw)));
      if (destination === this.multiProvider.getDomainId(origin)) {
        throw new Error('Dispatched message to local domain');
      }
      const destinationChain = this.multiProvider.getChainName(destination);
      const inbox = this.getContracts(destinationChain).mailbox;
      const message = String(messageRaw) as `0x${string}`;
      const id = messageId(message);
      const delivered = await inbox.delivered(id);
      if (!delivered) {
        const response = await inbox.process('0x', message);
        const destinationResponses = responses.get(destinationChain) || [];
        destinationResponses.push(response);
        responses.set(destinationChain, destinationResponses);
      }
    }
    return responses;
  }
}
