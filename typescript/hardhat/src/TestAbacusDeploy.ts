import { TestDeploy } from './TestDeploy';
import {
  AbacusConnectionManager,
  AbacusConnectionManager__factory,
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  Outbox,
  Outbox__factory,
  TestInbox,
  TestInbox__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
} from '@abacus-network/core';
import { types } from '@abacus-network/utils';
import { addressToBytes32 } from '@abacus-network/utils/dist/src/utils';
import { ethers } from 'ethers';

export type TestAbacusConfig = {
  signer: Record<types.Domain, ethers.Signer>;
};

// Outbox & inbox validator managers are not required for testing and are therefore omitted.
export type TestAbacusInstance = {
  outbox: Outbox;
  abacusConnectionManager: AbacusConnectionManager;
  upgradeBeaconController: UpgradeBeaconController;
  inboxes: Record<types.Domain, TestInbox>;
  interchainGasPaymaster: InterchainGasPaymaster;
};

export class TestAbacusDeploy extends TestDeploy<
  TestAbacusInstance,
  TestAbacusConfig
> {
  async deploy(domains: types.Domain[], signer: ethers.Signer) {
    // Clear previous deploy to support multiple tests.
    for (const domain of this.domains) {
      delete this.config.signer[domain];
      delete this.instances[domain];
    }
    for (const domain of domains) {
      this.config.signer[domain] = signer;
    }
    for (const domain of domains) {
      this.instances[domain] = await this.deployInstance(domain);
    }
  }

  async deployInstance(domain: types.Domain): Promise<TestAbacusInstance> {
    const signer = this.config.signer[domain];

    const upgradeBeaconControllerFactory = new UpgradeBeaconController__factory(
      signer,
    );
    const upgradeBeaconController =
      await upgradeBeaconControllerFactory.deploy();

    const outboxFactory = new Outbox__factory(signer);
    const outbox = await outboxFactory.deploy(domain);
    // Outbox will require the validator manager to be a contract. We don't
    // actually make use of the validator manager, so just we pass in the
    // upgradeBeaconController as the validator manager to satisfy the contract
    // requirement and avoid deploying a new validator manager.
    await outbox.initialize(upgradeBeaconController.address);

    const abacusConnectionManagerFactory = new AbacusConnectionManager__factory(
      signer,
    );
    const abacusConnectionManager =
      await abacusConnectionManagerFactory.deploy();
    await abacusConnectionManager.setOutbox(outbox.address);

    const interchainGasPaymasterFactory = new InterchainGasPaymaster__factory(
      signer,
    );
    const interchainGasPaymaster = await interchainGasPaymasterFactory.deploy();
    await abacusConnectionManager.setInterchainGasPaymaster(
      interchainGasPaymaster.address,
    );

    const inboxFactory = new TestInbox__factory(signer);
    const inboxes: Record<types.Domain, TestInbox> = {};

    // this.remotes reads this.instances which has not yet been set.
    const remotes = Object.keys(this.config.signer).map((d) => parseInt(d));
    const deploys = remotes.map(async (remote) => {
      const inbox = await inboxFactory.deploy(domain);
      // Inbox will require the validator manager to be a contract. We don't
      // actually make use of the validator manager, so we just pass in the
      // upgradeBeaconController as the validator manager to satisfy the contract
      // requirement and avoid deploying a new validator manager.
      await inbox.initialize(
        remote,
        upgradeBeaconController.address,
        ethers.constants.HashZero,
        0,
      );
      await abacusConnectionManager.enrollInbox(remote, inbox.address);
      inboxes[remote] = inbox;
    });
    await Promise.all(deploys);

    // dispatch a dummy event to allow a consumer to checkpoint/process a single message
    await outbox.dispatch(
      remotes.find((_) => _ !== domain)!,
      addressToBytes32(ethers.constants.AddressZero),
      '0x',
    );
    return {
      outbox,
      abacusConnectionManager,
      interchainGasPaymaster,
      inboxes,
      upgradeBeaconController,
    };
  }

  async transferOwnership(domain: types.Domain, address: types.Address) {
    await this.outbox(domain).transferOwnership(address);
    await this.upgradeBeaconController(domain).transferOwnership(address);
    await this.abacusConnectionManager(domain).transferOwnership(address);
    for (const remote of this.remotes(domain)) {
      await this.inbox(domain, remote).transferOwnership(address);
    }
  }

  outbox(domain: types.Domain): Outbox {
    return this.instances[domain].outbox;
  }

  upgradeBeaconController(domain: types.Domain): UpgradeBeaconController {
    return this.instances[domain].upgradeBeaconController;
  }

  inbox(origin: types.Domain, destination: types.Domain): TestInbox {
    return this.instances[destination].inboxes[origin];
  }

  interchainGasPaymaster(domain: types.Domain): InterchainGasPaymaster {
    return this.instances[domain].interchainGasPaymaster;
  }

  abacusConnectionManager(domain: types.Domain): AbacusConnectionManager {
    return this.instances[domain].abacusConnectionManager;
  }

  async processMessages(): Promise<
    Map<types.Domain, Map<types.Domain, ethers.providers.TransactionResponse[]>>
  > {
    const responses: Map<
      types.Domain,
      Map<types.Domain, ethers.providers.TransactionResponse[]>
    > = new Map();
    for (const origin of this.domains) {
      const outbound = await this.processOutboundMessages(origin);
      responses.set(origin, new Map());
      this.domains.forEach((destination) => {
        responses
          .get(origin)!
          .set(destination, outbound.get(destination) ?? []);
      });
    }
    return responses;
  }

  async processOutboundMessages(
    origin: types.Domain,
  ): Promise<Map<types.Domain, ethers.providers.TransactionResponse[]>> {
    const responses: Map<types.Domain, ethers.providers.TransactionResponse[]> =
      new Map();
    const outbox = this.outbox(origin);

    // Find all unprocessed messages dispatched on the Outbox and attempt to process them.
    const dispatchFilter = outbox.filters.Dispatch();
    const dispatches = await outbox.queryFilter(dispatchFilter);
    for (const dispatch of dispatches) {
      const destination = dispatch.args.destination;
      if (destination === origin)
        throw new Error('Dispatched message to local domain');
      const inbox = this.inbox(origin, destination);
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
        let destinationResponses = responses.get(destination) || [];
        destinationResponses.push(response);
        responses.set(destination, destinationResponses);
      }
    }
    return responses;
  }
}
