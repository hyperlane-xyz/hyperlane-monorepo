import { ethers } from 'ethers';

import { TestInbox, TestOutbox } from '@hyperlane-xyz/core';
import { types, utils } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../consts/chainMetadata';
import { DomainIdToChainName } from '../domains';
import { ProxiedContract } from '../proxy';
import { ChainMap, ChainName, Remotes, TestChainNames } from '../types';

import { HyperlaneCore } from './HyperlaneCore';
import { CoreContracts, InboxContracts, OutboxContracts } from './contracts';

type MockProxyAddresses = {
  kind: 'MOCK';
  proxy: string;
  implementation: string;
};

export type TestOutboxContracts = OutboxContracts & {
  outbox: ProxiedContract<TestOutbox, MockProxyAddresses>;
};
export type TestInboxContracts = InboxContracts & {
  inbox: ProxiedContract<TestInbox, MockProxyAddresses>;
};

export type TestCoreContracts<Local extends TestChainNames> = CoreContracts<
  TestChainNames,
  Local
> &
  TestOutboxContracts & {
    inboxes: ChainMap<Remotes<TestChainNames, Local>, TestInboxContracts>;
  };

export class TestCoreApp<
  TestChain extends TestChainNames = TestChainNames,
> extends HyperlaneCore<TestChain> {
  getContracts<Local extends TestChain>(
    chain: Local,
  ): TestCoreContracts<Local> {
    return super.getContracts(chain) as TestCoreContracts<Local>;
  }

  async processMessages(): Promise<
    Map<TestChain, Map<TestChain, ethers.providers.TransactionResponse[]>>
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

  async processOutboundMessages<Local extends TestChain>(
    origin: Local,
  ): Promise<Map<ChainName, ethers.providers.TransactionResponse[]>> {
    const responses = new Map<ChainName, any>();
    const contracts = this.getContracts(origin);
    const outbox: TestOutbox = contracts.outbox.contract;

    const dispatchFilter = outbox.filters.Dispatch();
    const dispatches = await outbox.queryFilter(dispatchFilter);
    for (const dispatch of dispatches) {
      const message = utils.parseMessage(dispatch.args.message);
      const destination = message.destination;
      if (destination === chainMetadata[origin].id) {
        throw new Error('Dispatched message to local domain');
      }
      const destinationChain = DomainIdToChainName[destination];
      const inbox: TestInbox =
        // @ts-ignore
        this.getContracts(destinationChain).inboxes[origin].inbox.contract;
      const status = await inbox.messages(
        utils.messageHash(
          dispatch.args.message,
          dispatch.args.leafIndex.toNumber(),
        ),
      );
      if (status !== types.MessageStatus.PROCESSED) {
        const response = await inbox.testProcess(
          dispatch.args.message,
          dispatch.args.leafIndex.toNumber(),
        );
        const destinationResponses = responses.get(destinationChain) || [];
        destinationResponses.push(response);
        responses.set(destinationChain, destinationResponses);
      }
    }
    return responses;
  }
}
