import { ethers } from "ethers";
import { types } from "@abacus-network/utils";
import {
  Outbox,
  Outbox__factory,
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
  XAppConnectionManager,
  XAppConnectionManager__factory,
  TestInbox,
  TestInbox__factory,
} from "@abacus-network/core";
import { TestDeploy } from "./TestDeploy";

export type TestAbacusConfig = {
  signer: Record<types.Domain, ethers.Signer>;
};

// Outbox & inbox validator managers are not required for testing and therefore omitted.
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
    const inboxDeploys = remotes.map(async (remote) => {
      // const inboxValidatorManager = inboxValidatorManagers[remote];
      const inbox = await inboxFactory.deploy(domain);
      // Inbox will require the validator manager to be a contract. We don't
      // actually make use of the validator manager, so we just pass in the
      // upgradeBeaconController as the validator manager to satisfy the contract
      // requirement and avoid deploying a new validator manager.
      await inbox.initialize(
        remote,
        xAppConnectionManager.address,
        ethers.constants.HashZero,
        0
      );
      await xAppConnectionManager.enrollInbox(remote, inbox.address);
      inboxes[remote] = inbox;
    });
    await Promise.all(inboxDeploys);
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
    // await this.outboxValidatorManager(domain).transferOwnership(address);
    for (const remote of this.remotes(domain)) {
      // await this.inboxValidatorManager(domain, remote).transferOwnership(
      //   address
      // );
      await this.inbox(domain, remote).transferOwnership(address);
    }
  }

  outbox(domain: types.Domain): Outbox {
    return this.instances[domain].outbox;
  }

  upgradeBeaconController(domain: types.Domain): UpgradeBeaconController {
    return this.instances[domain].upgradeBeaconController;
  }

  inbox(local: types.Domain, remote: types.Domain): TestInbox {
    return this.instances[local].inboxes[remote];
  }

  interchainGasPaymaster(domain: types.Domain): InterchainGasPaymaster {
    return this.instances[domain].interchainGasPaymaster;
  }

  xAppConnectionManager(domain: types.Domain): XAppConnectionManager {
    return this.instances[domain].xAppConnectionManager;
  }

  // outboxValidatorManager(domain: types.Domain): OutboxValidatorManager {
  //   return this.instances[domain].outboxValidatorManager;
  // }

  // inboxValidatorManager(
  //   local: types.Domain,
  //   remote: types.Domain
  // ): InboxValidatorManager {
  //   return this.instances[local].inboxValidatorManagers[remote];
  // }

  async processMessages() {
    await Promise.all(
      this.domains.map((d) => this.processMessagesFromDomain(d))
    );
  }

  async processMessagesFromDomain(domain: types.Domain) {
    const outbox = this.outbox(domain);
    const [checkpointedRoot, checkpointedIndex] =
      await outbox.latestCheckpoint();
    const latestIndex = await outbox.tree();
    if (latestIndex.eq(checkpointedIndex)) return;

    // Find the block number of the last checkpoint submitted on Outbox.
    const checkpointFilter = outbox.filters.Checkpoint(checkpointedRoot);
    const checkpoints = await outbox.queryFilter(checkpointFilter);
    if (!(checkpoints.length === 0 || checkpoints.length === 1))
      throw new Error("found multiple checkpoints");
    const fromBlock = checkpoints.length === 0 ? 0 : checkpoints[0].blockNumber;

    await outbox.checkpoint();
    const [root, index] = await outbox.latestCheckpoint();
    // If there have been no checkpoints since the last checkpoint, return.
    if (
      index.eq(0) ||
      (checkpoints.length == 1 && index.eq(checkpoints[0].args.index))
    ) {
      return;
    }
    // Update the Outbox and Inboxes to the latest roots.
    // This is technically not necessary given that we are not proving against
    // a root in the TestInbox.
    // const validator = await Validator.fromSigner(
    //   this.config.signer[domain],
    //   domain
    // );
    // const { signature } = await validator.signCheckpoint(
    //   root,
    //   index.toNumber()
    // );

    for (const remote of this.remotes(domain)) {
      const inbox = this.inbox(remote, domain);
      // const inboxValidatorManager = this.inboxValidatorManager(remote, domain);
      await inbox.setCheckpoint(root, index);
    }

    // Find all messages dispatched on the outbox since the previous checkpoint.
    const dispatchFilter = outbox.filters.Dispatch();
    const dispatches = await outbox.queryFilter(dispatchFilter, fromBlock);
    for (const dispatch of dispatches) {
      const destination = dispatch.args.destinationAndNonce.shr(32).toNumber();
      if (destination !== domain) {
        const inbox = this.inbox(destination, domain);
        await inbox.setMessageProven(dispatch.args.message);
        await inbox.testProcess(dispatch.args.message);
      }
    }
  }
}
