import {
  TestInbox,
  TestInbox__factory,
  TestOutbox__factory,
} from '@abacus-network/core';
import {
  AbacusCore,
  chainMetadata,
  DomainIdToChainName,
  objMap,
  TestChainNames,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';

export class TestCoreApp extends AbacusCore<TestChainNames> {
  getContracts<Local extends TestChainNames>(chain: Local) {
    const contracts = super.getContracts(chain);
    return {
      ...contracts,
      outbox: {
        ...contracts.outbox,
        outbox: TestOutbox__factory.connect(
          contracts.outbox.outbox.address,
          contracts.outbox.outbox.signer,
        ),
      },
      inboxes: objMap(contracts.inboxes, (_, inbox) => ({
        ...inbox,
        inbox: TestInbox__factory.connect(
          inbox.inbox.address,
          inbox.inbox.signer,
        ),
      })),
    };
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
    const [root, index] = await outbox.latestCheckpoint();

    // Find all unprocessed messages dispatched on the outbox since the previous checkpoint.
    const dispatchFilter = outbox.filters.Dispatch();
    const dispatches = await outbox.queryFilter(dispatchFilter);
    for (const dispatch of dispatches) {
      if (dispatch.args.leafIndex > index) {
        // Message has not been checkpointed on the outbox
        break;
      }

      const destination = dispatch.args.destination;
      if (destination === chainMetadata[origin].id) {
        throw new Error('Dispatched message to local domain');
      }
      const destinationChain = DomainIdToChainName[destination];
      const inbox: TestInbox =
        // @ts-ignore
        this.getContracts(destinationChain).inboxes[origin].inbox;
      const status = await inbox.messages(dispatch.args.messageHash);
      if (status !== types.MessageStatus.PROCESSED) {
        if (dispatch.args.leafIndex.toNumber() == 0) {
          // disregard the dummy message
          continue;
        }

        const [, inboxCheckpointIndex] = await inbox.latestCheckpoint();
        if (
          inboxCheckpointIndex < dispatch.args.leafIndex &&
          inboxCheckpointIndex < index
        ) {
          await inbox.setCheckpoint(root, index);
        }

        const response = await inbox.testProcess(
          dispatch.args.message,
          dispatch.args.leafIndex.toNumber(),
        );
        let destinationResponses = responses.get(destinationChain) || [];
        destinationResponses.push(response);
        responses.set(destinationChain, destinationResponses);
      }
    }
    return responses;
  }
}
