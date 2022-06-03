import { TestInbox, TestOutbox } from '@abacus-network/core';
import {
  AbacusCore,
  ChainMap,
  CoreContracts,
  DomainIdToChainName,
  InboxContracts,
  OutboxContracts,
  ProxiedContract,
  Remotes,
  TestChainNames,
  chainMetadata,
} from '@abacus-network/sdk';
import { types, utils } from '@abacus-network/utils';
import { ethers } from 'ethers';

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

export class TestCoreApp extends AbacusCore<TestChainNames> {
  getContracts<Local extends TestChainNames>(
    chain: Local,
  ): TestCoreContracts<Local> {
    return super.getContracts(chain) as TestCoreContracts<Local>;
  }

  async processMessages(): Promise<
    Map<
      TestChainNames,
      Map<TestChainNames, ethers.providers.TransactionResponse[]>
    >
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

  async processOutboundMessages<Local extends TestChainNames>(origin: Local) {
    const responses = new Map();
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
