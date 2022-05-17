import { TestInbox, TestInbox__factory, TestOutbox, TestOutbox__factory } from "@abacus-network/core";
import { AbacusCore, CoreContractAddresses, DomainIdToChainName, domains, MultiProvider, objMap, Remotes } from "@abacus-network/sdk";
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import { TestNetworks } from './types';

export class TestCoreApp extends AbacusCore<TestNetworks> {
  private testContracts: {
    [local in TestNetworks]: {
      outbox: TestOutbox
      inboxes: {
        [remote in Remotes<TestNetworks, local>]: TestInbox
      }
    }
  }

  constructor(
    networkAddresses: {
      [local in TestNetworks]: CoreContractAddresses<TestNetworks, local>;
    },
    multiProvider: MultiProvider<TestNetworks>,
  ) {
    super(networkAddresses, multiProvider);
    this.testContracts = objMap(networkAddresses, (local, addresses) => {
      const connection = multiProvider.getChainConnection(local).signer || multiProvider.getChainConnection(local).provider;
      const outbox = addresses.outbox;
      return {
        outbox: TestOutbox__factory.connect(outbox.proxy, connection!),
        inboxes: objMap(addresses.inboxes as any, (_, inbox) =>
          TestInbox__factory.connect(inbox.proxy, connection!))
      };
    });
  }

  outbox(local: TestNetworks) {
    return this.testContracts[local].outbox;
  }

  inbox<Local extends TestNetworks>(destination: Local, origin: Remotes<TestNetworks, Local>) {
    return this.testContracts[destination].inboxes[origin];
  }

  async processMessages(): Promise<Map<TestNetworks, Map<TestNetworks, ethers.providers.TransactionResponse[]>>> {
    const responses = new Map();
    for (const origin of this.networks()) {
      const outbound = await this.processOutboundMessages(origin);
      const originResponses = new Map();
      this.remotes(origin).forEach((destination) => 
        originResponses.set(destination, outbound.get(destination))
      );
      responses.set(origin, originResponses);
    }
    return responses;
  }

  async processOutboundMessages<Local extends TestNetworks>(
    origin: Local,
  ) {
    const responses = new Map();
    const outbox = this.outbox(origin);
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
      const inbox = this.inbox(destinationNetwork, origin as any);
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
