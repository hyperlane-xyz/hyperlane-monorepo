import {
  TestInbox,
  TestInbox__factory,
  TestOutbox,
  TestOutbox__factory,
} from '@abacus-network/core';
import {
  AbacusCore,
  CoreContractAddresses,
  DomainIdToChainName,
  domains,
  MultiProvider,
  objMap,
  Remotes,
  TestChainNames,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';

export class TestCoreApp extends AbacusCore<TestChainNames> {
  private testContracts: {
    [LocalChain in TestChainNames]: {
      outbox: TestOutbox;
      inboxes: Record<Remotes<TestChainNames, LocalChain>, TestInbox>;
    };
  };

  constructor(
    chainAddresses: {
      [LocalChain in TestChainNames]: CoreContractAddresses<
        TestChainNames,
        LocalChain
      >;
    },
    multiProvider: MultiProvider<TestChainNames>,
  ) {
    super(chainAddresses, multiProvider);
    this.testContracts = objMap(chainAddresses, (local, addresses) => {
      const chainConnection = multiProvider.getChainConnection(local);
      const connection = chainConnection.signer || chainConnection.provider;
      return {
        outbox: TestOutbox__factory.connect(
          addresses.outbox.proxy,
          connection!,
        ),
        inboxes: objMap(addresses.inboxes as any, (_, inbox) =>
          TestInbox__factory.connect(inbox.proxy, connection!),
        ) as any,
      };
    });
  }

  outbox(local: TestChainNames) {
    return this.testContracts[local].outbox;
  }

  inbox<LocalChain extends TestChainNames>(
    destination: LocalChain,
    origin: Remotes<TestChainNames, LocalChain>,
  ) {
    return this.testContracts[destination].inboxes[origin];
  }

  async processMessages(): Promise<
    Map<
      TestChainNames,
      Map<TestChainNames, ethers.providers.TransactionResponse[]>
    >
  > {
    const responses = new Map();
    for (const origin of this.networks()) {
      const outbound = await this.processOutboundMessages(origin);
      const originResponses = new Map();
      this.remotes(origin).forEach((destination) =>
        originResponses.set(destination, outbound.get(destination)),
      );
      responses.set(origin, originResponses);
    }
    return responses;
  }

  async processOutboundMessages<Local extends TestChainNames>(origin: Local) {
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
      const destinationChain = DomainIdToChainName[destination] as Remotes<
        TestChainNames,
        Local
      >;
      const inbox = this.inbox(destinationChain, origin as any);
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
