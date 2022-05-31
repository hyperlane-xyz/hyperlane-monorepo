import { TestInbox } from '@abacus-network/core';
import {
  AbacusCore,
  chainMetadata,
  DomainIdToChainName,
  Remotes,
  TestChainNames,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';

export class TestCoreApp extends AbacusCore<TestChainNames> {
  getInbox<Local extends TestChainNames>(
    chain: Local,
    remote: Remotes<TestChainNames, Local>,
  ) {
    return this.getContracts(chain).inboxes[remote].inbox as TestInbox;
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
    const outbox = contracts.outbox.outbox;

    const dispatchFilter = outbox.filters.Dispatch();
    const dispatches = await outbox.queryFilter(dispatchFilter);
    for (const dispatch of dispatches) {
      const destination = dispatch.args.destination;
      if (destination === chainMetadata[origin].id) {
        throw new Error('Dispatched message to local domain');
      }
      const destinationChain = DomainIdToChainName[
        destination
      ] as TestChainNames;
      const inbox = this.getInbox(destinationChain, origin as never);
      const status = await inbox.messages(dispatch.args.messageHash);
      if (status !== types.MessageStatus.PROCESSED) {
        if (dispatch.args.leafIndex.toNumber() == 0) {
          // disregard the dummy message
          continue;
        }

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
