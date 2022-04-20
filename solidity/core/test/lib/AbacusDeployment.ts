import { assert } from 'chai';
import * as ethers from 'ethers';
import { types } from '@abacus-network/utils';

import { Validator } from './core';

import {
  TestOutbox,
  TestOutbox__factory,
  ValidatorManager,
  ValidatorManager__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
  AbacusConnectionManager,
  AbacusConnectionManager__factory,
  TestInbox,
  TestInbox__factory,
} from '../../types';

export interface AbacusInstance {
  domain: types.Domain;
  validator: Validator;
  validatorManager: ValidatorManager;
  outbox: TestOutbox;
  connectionManager: AbacusConnectionManager;
  ubc: UpgradeBeaconController;
  inboxs: Record<number, TestInbox>;
}

export class AbacusDeployment {
  constructor(
    public readonly domains: types.Domain[],
    public readonly instances: Record<number, AbacusInstance>,
    public readonly signer: ethers.Signer,
  ) {}

  static async fromDomains(domains: types.Domain[], signer: ethers.Signer) {
    const instances: Record<number, AbacusInstance> = {};
    for (const local of domains) {
      const instance = await AbacusDeployment.deployInstance(
        local,
        domains.filter((d) => d !== local),
        signer,
      );
      instances[local] = instance;
    }
    return new AbacusDeployment(domains, instances, signer);
  }

  static async deployInstance(
    local: types.Domain,
    remotes: types.Domain[],
    signer: ethers.Signer,
  ): Promise<AbacusInstance> {
    const validatorManagerFactory = new ValidatorManager__factory(signer);
    const validatorManager = await validatorManagerFactory.deploy();
    await validatorManager.enrollValidator(local, await signer.getAddress());
    await Promise.all(
      remotes.map(async (remoteDomain) =>
        validatorManager.enrollValidator(
          remoteDomain,
          await signer.getAddress(),
        ),
      ),
    );

    const ubcFactory = new UpgradeBeaconController__factory(signer);
    const ubc = await ubcFactory.deploy();

    const outboxFactory = new TestOutbox__factory(signer);
    const outbox = await outboxFactory.deploy(local);
    await outbox.initialize(validatorManager.address);

    const connectionManagerFactory = new AbacusConnectionManager__factory(
      signer,
    );
    const connectionManager = await connectionManagerFactory.deploy();
    await connectionManager.setOutbox(outbox.address);

    const inboxFactory = new TestInbox__factory(signer);
    const inboxs: Record<number, TestInbox> = {};
    const deploys = remotes.map(async (remoteDomain) => {
      const inbox = await inboxFactory.deploy(local);
      await inbox.initialize(
        remoteDomain,
        validatorManager.address,
        ethers.constants.HashZero,
        0,
      );
      await connectionManager.enrollInbox(remoteDomain, inbox.address);
      inboxs[remoteDomain] = inbox;
    });
    await Promise.all(deploys);
    return {
      domain: local,
      validator: await Validator.fromSigner(signer, local),
      outbox,
      connectionManager,
      validatorManager,
      inboxs,
      ubc,
    };
  }

  async transferOwnership(domain: types.Domain, address: types.Address) {
    await this.outbox(domain).transferOwnership(address);
    await this.ubc(domain).transferOwnership(address);
    await this.connectionManager(domain).transferOwnership(address);
    await this.validatorManager(domain).transferOwnership(address);
    for (const remote of this.domains) {
      if (remote !== domain) {
        await this.inbox(domain, remote).transferOwnership(address);
      }
    }
  }

  outbox(domain: types.Domain): TestOutbox {
    return this.instances[domain].outbox;
  }

  ubc(domain: types.Domain): UpgradeBeaconController {
    return this.instances[domain].ubc;
  }

  validator(domain: types.Domain): Validator {
    return this.instances[domain].validator;
  }

  inbox(local: types.Domain, remote: types.Domain): TestInbox {
    return this.instances[local].inboxs[remote];
  }

  connectionManager(domain: types.Domain): AbacusConnectionManager {
    return this.instances[domain].connectionManager;
  }

  validatorManager(domain: types.Domain): ValidatorManager {
    return this.instances[domain].validatorManager;
  }

  async processMessages() {
    await Promise.all(
      this.domains.map((d) => this.processMessagesFromDomain(d)),
    );
  }

  async processMessagesFromDomain(local: types.Domain) {
    const outbox = this.outbox(local);
    const [checkpointedRoot, checkpointedIndex] =
      await outbox.latestCheckpoint();
    const latestIndex = await outbox.tree();
    if (latestIndex.eq(checkpointedIndex)) return;

    // Find the block number of the last checkpoint submitted on Outbox.
    const checkpointFilter = outbox.filters.Checkpoint(checkpointedRoot);
    const checkpoints = await outbox.queryFilter(checkpointFilter);
    assert(checkpoints.length === 0 || checkpoints.length === 1);
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
    // Update the Outbox and Inboxs to the latest roots.
    // This is technically not necessary given that we are not proving against
    // a root in the TestInbox.
    const validator = this.validator(local);
    const { signature } = await validator.signCheckpoint(
      root,
      index.toNumber(),
    );

    for (const remote of this.domains) {
      if (remote !== local) {
        const inbox = this.inbox(remote, local);
        await inbox.checkpoint(root, index, signature);
      }
    }

    // Find all messages dispatched on the outbox since the previous checkpoint.
    const dispatchFilter = outbox.filters.Dispatch();
    const dispatches = await outbox.queryFilter(dispatchFilter, fromBlock);
    for (const dispatch of dispatches) {
      const destination = dispatch.args.destinationAndNonce.shr(32).toNumber();
      if (destination !== local) {
        const inbox = this.inbox(destination, local);
        await inbox.setMessageProven(dispatch.args.message);
        await inbox.testProcess(dispatch.args.message);
      }
    }
  }
}

export const abacus: any = {
  AbacusDeployment,
};
