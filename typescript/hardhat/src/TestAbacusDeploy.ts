import { ethers } from "ethers";
import { types } from "@abacus-network/utils";
import {
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  Outbox,
  Outbox__factory,
  TestInbox,
  TestInbox__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
  XAppConnectionManager,
  XAppConnectionManager__factory,
} from "@abacus-network/core";
import { TestDeploy } from "./TestDeploy";

export type TestAbacusConfig = {
  signer: Record<types.Domain, ethers.Signer>;
};

// Outbox & inbox validator managers are not required for testing and are therefore omitted.
export type TestAbacusInstance = {
  outbox: Outbox;
  xAppConnectionManager: XAppConnectionManager;
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
      signer
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

    const xAppConnectionManagerFactory = new XAppConnectionManager__factory(
      signer
    );
    const xAppConnectionManager = await xAppConnectionManagerFactory.deploy();
    await xAppConnectionManager.setOutbox(outbox.address);

    const interchainGasPaymasterFactory = new InterchainGasPaymaster__factory(
      signer
    );
    const interchainGasPaymaster = await interchainGasPaymasterFactory.deploy();
    await xAppConnectionManager.setInterchainGasPaymaster(
      interchainGasPaymaster.address
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
        0
      );
      await xAppConnectionManager.enrollInbox(remote, inbox.address);
      inboxes[remote] = inbox;
    });
    await Promise.all(deploys);
    return {
      outbox,
      xAppConnectionManager,
      interchainGasPaymaster,
      inboxes,
      upgradeBeaconController,
    };
  }

  async transferOwnership(domain: types.Domain, address: types.Address) {
    await this.outbox(domain).transferOwnership(address);
    await this.upgradeBeaconController(domain).transferOwnership(address);
    await this.xAppConnectionManager(domain).transferOwnership(address);
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

  xAppConnectionManager(domain: types.Domain): XAppConnectionManager {
    return this.instances[domain].xAppConnectionManager;
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
    origin: types.Domain
  ): Promise<Map<types.Domain, ethers.providers.TransactionResponse[]>> {
    const responses: Map<types.Domain, ethers.providers.TransactionResponse[]> =
      new Map();
    const outbox = this.outbox(origin);
    const [, checkpointedIndex] = await outbox.latestCheckpoint();
    const latestIndex = await outbox.count();
    if (latestIndex.eq(checkpointedIndex)) return responses;

    await outbox.checkpoint();
    const [root, index] = await outbox.latestCheckpoint();

    for (const destination of this.remotes(origin)) {
      const inbox = this.inbox(origin, destination);
      await inbox.setCheckpoint(root, index);
    }

    // Find all unprocessed messages dispatched on the outbox since the previous checkpoint.
    const dispatchFilter = outbox.filters.Dispatch();
    const dispatches = await outbox.queryFilter(dispatchFilter);
    for (const dispatch of dispatches) {
      const destination = dispatch.args.destinationAndNonce.shr(32).toNumber();
      if (destination === origin)
        throw new Error("Dispatched message to local domain");
      const inbox = this.inbox(origin, destination);
      const status = await inbox.messages(dispatch.args.messageHash);
      if (status !== types.MessageStatus.PROCESSED) {
        await inbox.setMessageProven(dispatch.args.message);
        const response = await inbox.testProcess(dispatch.args.message);
        let destinationResponses = responses.get(destination) || [];
        destinationResponses.push(response);
        responses.set(destination, destinationResponses);
      }
    }
    return responses;
  }
}
