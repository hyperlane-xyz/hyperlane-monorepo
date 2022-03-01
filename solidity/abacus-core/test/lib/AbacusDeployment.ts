import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { assert } from 'chai';
import * as ethers from 'ethers';

import * as types from './types';
import { Validator } from './core';

import {
  TestHome,
  TestHome__factory,
  ValidatorManager,
  ValidatorManager__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
  XAppConnectionManager,
  XAppConnectionManager__factory,
  TestReplica,
  TestReplica__factory,
} from '../../typechain';

export interface AbacusInstance {
  domain: types.Domain;
  validator: Validator;
  validatorManager: ValidatorManager;
  home: TestHome;
  connectionManager: XAppConnectionManager;
  ubc: UpgradeBeaconController;
  replicas: Record<number, TestReplica>;
}

const processGas = 850000;
const reserveGas = 15000;
const optimisticSeconds = 0;

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
    await validatorManager.setValidator(local, await signer.getAddress());
    await Promise.all(
      remotes.map(async (remoteDomain) =>
        validatorManager.setValidator(remoteDomain, await signer.getAddress()),
      ),
    );

    const ubcFactory = new UpgradeBeaconController__factory(signer);
    const ubc = await ubcFactory.deploy();

    const homeFactory = new TestHome__factory(signer);
    const home = await homeFactory.deploy(local);
    await home.initialize(validatorManager.address);

    const connectionManagerFactory = new XAppConnectionManager__factory(signer);
    const connectionManager = await connectionManagerFactory.deploy();
    await connectionManager.setHome(home.address);

    const replicaFactory = new TestReplica__factory(signer);
    const replicas: Record<number, TestReplica> = {};
    const deploys = remotes.map(async (remoteDomain) => {
      const replica = await replicaFactory.deploy(
        local,
        processGas,
        reserveGas,
      );
      await replica.initialize(remoteDomain, validatorManager.address, 0);
      await connectionManager.enrollReplica(replica.address, remoteDomain);
      replicas[remoteDomain] = replica;
    });
    await Promise.all(deploys);
    return {
      domain: local,
      validator: await Validator.fromSigner(signer, local),
      home,
      connectionManager,
      validatorManager,
      replicas,
      ubc,
    };
  }

  async transferOwnership(domain: types.Domain, address: types.Address) {
    await this.home(domain).transferOwnership(address);
    await this.ubc(domain).transferOwnership(address);
    await this.connectionManager(domain).transferOwnership(address);
    await this.validatorManager(domain).transferOwnership(address);
    for (const remote of this.domains) {
      if (remote !== domain) {
        await this.replica(domain, remote).transferOwnership(address);
      }
    }
  }

  home(domain: types.Domain): TestHome {
    return this.instances[domain].home;
  }

  ubc(domain: types.Domain): UpgradeBeaconController {
    return this.instances[domain].ubc;
  }

  validator(domain: types.Domain): Validator {
    return this.instances[domain].validator;
  }

  replica(local: types.Domain, remote: types.Domain): TestReplica {
    return this.instances[local].replicas[remote];
  }

  connectionManager(domain: types.Domain): XAppConnectionManager {
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
    const home = this.home(local);
    const [checkpointedRoot] = await home.latestCheckpoint();

    // Find the block number of the last checkpoint submitted on Home.
    const checkpointFilter = home.filters.Checkpoint(checkpointedRoot);
    const checkpoints = await home.queryFilter(checkpointFilter);
    assert(checkpoints.length === 0 || checkpoints.length === 1);
    const fromBlock = checkpoints.length === 0 ? 0 : checkpoints[0].blockNumber;

    await home.checkpoint();
    const [root, index] = await home.latestCheckpoint();
    // Update the Home and Replicas to the latest roots.
    // This is technically not necessary given that we are not proving against
    // a root in the TestReplica.
    const validator = this.validator(local);
    const { signature } = await validator.signCheckpoint(root, index.toNumber());

    for (const remote of this.domains) {
      if (remote !== local) {
        const replica = this.replica(remote, local);
        await replica.checkpoint(root, index, signature);
      }
    }

    // Find all messages dispatched on the home since the previous update.
    const dispatchFilter = home.filters.Dispatch();
    const dispatches = await home.queryFilter(dispatchFilter, fromBlock);
    for (const dispatch of dispatches) {
      const destination = dispatch.args.destinationAndNonce.shr(32).toNumber();
      if (destination !== local) {
        const replica = this.replica(destination, local);
        await replica.setMessageProven(dispatch.args.message);
        await replica.testProcess(dispatch.args.message);
      }
    }
  }
}

export const abacus: any = {
  AbacusDeployment,
};
