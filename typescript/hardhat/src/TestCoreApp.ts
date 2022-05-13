import { AbacusCore, DomainIdToChainName, domains, Remotes } from "@abacus-network/sdk";
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import { TestNetworks } from './types';

export class TestCoreApp extends AbacusCore<TestNetworks> {
  async processMessages() {
    const responses: Map<
      TestNetworks,
      Map<TestNetworks, ethers.providers.TransactionResponse[]>
    > = new Map();
    for (const origin of this.networks()) {
      const outbound = await this.processOutboundMessages(origin);
      responses.set(origin, new Map());
      this.networks().forEach((destination) => {
        responses
          .get(origin)!
          .set(destination, outbound.get(destination) ?? []);
      });
    }
    return responses;
  }

  async processOutboundMessages<Local extends TestNetworks>(
    origin: Local,
  ) {
    const responses: Map<TestNetworks, ethers.providers.TransactionResponse[]> =
      new Map();
    const originContracts = this.getContracts(origin);
    const outbox = originContracts.outbox.outbox;
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
      if (destination === domains[origin].id) {
        throw new Error('Dispatched message to local domain');
      }
      const destinationNetwork = DomainIdToChainName[destination] as Remotes<TestNetworks, Local>;
      const inbox = originContracts.inboxes[destinationNetwork].inbox;
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
        let destinationResponses = responses.get(destinationNetwork) || [];
        destinationResponses.push(response);
        responses.set(destinationNetwork, destinationResponses);
      }
    }
    return responses;
  }
}
