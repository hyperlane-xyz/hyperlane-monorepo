import { ethers } from "ethers";
import { types } from "@abacus-network/utils";
import {
  Outbox,
  Outbox__factory,
  ValidatorManager,
  ValidatorManager__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
  XAppConnectionManager,
  XAppConnectionManager__factory,
  TestInbox,
  TestInbox__factory,
} from "@abacus-network/core";
import { Validator } from "@abacus-network/core/test/lib/core";
import { TestDeploy } from "./TestDeploy";

export type TestAbacusConfig = {
  signer: Record<types.Domain, ethers.Signer>;
};

export type TestAbacusInstance = {
  validatorManager: ValidatorManager;
  outbox: Outbox;
  xAppConnectionManager: XAppConnectionManager;
  upgradeBeaconController: UpgradeBeaconController;
  inboxes: Record<types.Domain, TestInbox>;
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
    const signerAddress = await signer.getAddress();
    const validatorManagerFactory = new ValidatorManager__factory(signer);
    const validatorManager = await validatorManagerFactory.deploy();
    await validatorManager.enrollValidator(domain, signerAddress);
    await Promise.all(
      this.remotes(domain).map(async (remote) =>
        validatorManager.enrollValidator(remote, signerAddress)
      )
    );

    const upgradeBeaconControllerFactory = new UpgradeBeaconController__factory(
      signer
    );
    const upgradeBeaconController =
      await upgradeBeaconControllerFactory.deploy();

    const outboxFactory = new Outbox__factory(signer);
    const outbox = await outboxFactory.deploy(domain);
    await outbox.initialize(validatorManager.address);

    const xAppConnectionManagerFactory = new XAppConnectionManager__factory(
      signer
    );
    const xAppConnectionManager = await xAppConnectionManagerFactory.deploy();
    await xAppConnectionManager.setOutbox(outbox.address);

    const inboxFactory = new TestInbox__factory(signer);
    const inboxes: Record<types.Domain, TestInbox> = {};
    // this.remotes reads this.instances which has not yet been set.
    const remotes = Object.keys(this.config.signer).map((d) => parseInt(d));
    const deploys = remotes.map(async (remote) => {
      const inbox = await inboxFactory.deploy(domain);
      await inbox.initialize(
        remote,
        validatorManager.address,
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
      validatorManager,
      inboxes,
      upgradeBeaconController,
    };
  }

  async transferOwnership(domain: types.Domain, address: types.Address) {
    await this.outbox(domain).transferOwnership(address);
    await this.upgradeBeaconController(domain).transferOwnership(address);
    await this.xAppConnectionManager(domain).transferOwnership(address);
    await this.validatorManager(domain).transferOwnership(address);
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

  inbox(local: types.Domain, remote: types.Domain): TestInbox {
    return this.instances[local].inboxes[remote];
  }

  xAppConnectionManager(domain: types.Domain): XAppConnectionManager {
    return this.instances[domain].xAppConnectionManager;
  }

  validatorManager(domain: types.Domain): ValidatorManager {
    return this.instances[domain].validatorManager;
  }

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
    const validator = await Validator.fromSigner(
      this.config.signer[domain],
      domain
    );
    const { signature } = await validator.signCheckpoint(
      root,
      index.toNumber()
    );

    for (const remote of this.remotes(domain)) {
      const inbox = this.inbox(remote, domain);
      await inbox.checkpoint(root, index, signature);
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
