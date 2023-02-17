import { ethers } from 'ethers';

import { TestMailbox } from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { ProxiedContract } from '../proxy';
import { ChainName } from '../types';

import { HyperlaneCore } from './HyperlaneCore';
import { CoreContracts } from './contracts';

type MockProxyAddresses = {
  kind: 'MOCK';
  proxy: string;
  implementation: string;
};

export type TestCoreContracts = CoreContracts & {
  mailbox: ProxiedContract<TestMailbox, MockProxyAddresses>;
};

export class TestCoreApp extends HyperlaneCore {
  getContracts(chain: ChainName): TestCoreContracts {
    return super.getContracts(chain) as TestCoreContracts;
  }

  async processMessages(): Promise<
    Map<ChainName, Map<ChainName, ethers.providers.TransactionResponse[]>>
  > {
    const responses = new Map();
    for (const origin of this.chains()) {
      const outbound = await this.processOutboundMessages(origin);
      const originResponses = new Map();
      this.remoteChains(origin).forEach((destination) =>
        originResponses.set(destination, outbound.get(destination)),
      );
      responses.set(origin, originResponses);
    }
    return responses;
  }

  async processOutboundMessages(
    origin: ChainName,
  ): Promise<Map<ChainName, ethers.providers.TransactionResponse[]>> {
    const responses = new Map<ChainName, any>();
    const contracts = this.getContracts(origin);
    const outbox: TestMailbox = contracts.mailbox.contract;

    const dispatchFilter = outbox.filters.Dispatch();
    const dispatches = await outbox.queryFilter(dispatchFilter);
    for (const dispatch of dispatches) {
      const destination = dispatch.args.destination;
      if (destination === this.multiProvider.getDomainId(origin)) {
        throw new Error('Dispatched message to local domain');
      }
      const destinationChain = this.multiProvider.getChainName(destination);
      const inbox = this.getContracts(destinationChain).mailbox.contract;
      const id = utils.messageId(dispatch.args.message);
      const delivered = await inbox.delivered(id);
      if (!delivered) {
        const response = await inbox.process('0x', dispatch.args.message);
        const destinationResponses = responses.get(destinationChain) || [];
        destinationResponses.push(response);
        responses.set(destinationChain, destinationResponses);
      }
    }
    return responses;
  }
}
