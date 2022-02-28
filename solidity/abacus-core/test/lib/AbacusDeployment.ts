import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { assert } from "chai";
import * as ethers from "ethers";

import * as types from "./types";
import { Updater } from "./core";

import {
  TestHome,
  TestHome__factory,
  UpdaterManager,
  UpdaterManager__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
  XAppConnectionManager,
  XAppConnectionManager__factory,
  TestReplica,
  TestReplica__factory,
} from "../../typechain";

export interface AbacusInstance {
  domain: types.Domain;
  updater: Updater;
  updaterManager: UpdaterManager;
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
    public readonly signer: ethers.Signer
  ) {}

  static async fromDomains(domains: types.Domain[], signer: ethers.Signer) {
    const instances: Record<number, AbacusInstance> = {};
    for (const local of domains) {
      const instance = await AbacusDeployment.deployInstance(
        local,
        domains.filter((d) => d !== local),
        signer
      );
      instances[local] = instance;
    }
    return new AbacusDeployment(domains, instances, signer);
  }

  static async deployInstance(
    local: types.Domain,
    remotes: types.Domain[],
    signer: ethers.Signer
  ): Promise<AbacusInstance> {
    const updaterManagerFactory = new UpdaterManager__factory(signer);
    const updaterManager = await updaterManagerFactory.deploy(
      await signer.getAddress()
    );

    const ubcFactory = new UpgradeBeaconController__factory(signer);
    const ubc = await ubcFactory.deploy();

    const homeFactory = new TestHome__factory(signer);
    const home = await homeFactory.deploy(local);
    await home.initialize(updaterManager.address);

    const connectionManagerFactory = new XAppConnectionManager__factory(signer);
    const connectionManager = await connectionManagerFactory.deploy();
    await connectionManager.setHome(home.address);

    const replicaFactory = new TestReplica__factory(signer);
    const replicas: Record<number, TestReplica> = {};
    const deploys = remotes.map(async (remoteDomain) => {
      const replica = await replicaFactory.deploy(
        local,
        processGas,
        reserveGas
      );
      await replica.initialize(
        remoteDomain,
        await signer.getAddress(),
        ethers.constants.HashZero,
        optimisticSeconds
      );
      await connectionManager.ownerEnrollReplica(replica.address, remoteDomain);
      replicas[remoteDomain] = replica;
    });
    await Promise.all(deploys);
    return {
      domain: local,
      updater: await Updater.fromSigner(signer, local),
      home,
      connectionManager,
      updaterManager,
      replicas,
      ubc,
    };
  }

  home(domain: types.Domain): TestHome {
    return this.instances[domain].home;
  }

  ubc(domain: types.Domain): UpgradeBeaconController {
    return this.instances[domain].ubc;
  }

  updater(domain: types.Domain): Updater {
    return this.instances[domain].updater;
  }

  replica(local: types.Domain, remote: types.Domain): TestReplica {
    return this.instances[local].replicas[remote];
  }

  connectionManager(domain: types.Domain): XAppConnectionManager {
    return this.instances[domain].connectionManager;
  }


  async update() {
    await Promise.all(this.domains.map((d) => this.localUpdate(d)));
  }


  async localUpdate(local: types.Domain) {
    const home = this.home(local);
    const [committedRoot, latestRoot] = await home.suggestUpdate();

    // Find the block number of the last update submitted on Home.
    const updateFilter = home.filters.Update(null, null, committedRoot);
    const updates = await home.queryFilter(updateFilter);
    assert(updates.length === 0 || updates.length === 1);
    const fromBlock = updates.length === 0 ? 0 : updates[0].blockNumber;

    // Update the Home and Replicas to the latest roots.
    const updater = this.updater(local);
    const { signature } = await updater.signUpdate(committedRoot, latestRoot);
    await home.update(committedRoot, latestRoot, signature);

    for (const remote of this.domains) {
      if (remote !== local) {
        const replica = this.replica(remote, local);
        await replica.update(committedRoot, latestRoot, signature);
      }
    }

    // Prove and process all dispatched messages since the previous update.
    const previousMessageCount =
      fromBlock == 0
        ? ethers.BigNumber.from(0)
        : await home.nextLeafIndex({ blockTag: fromBlock });
    const currentMessageCount = await home.nextLeafIndex();
    for (
      let i = previousMessageCount;
      i.lt(currentMessageCount);
      i = i.add(1)
    ) {
      const dispatchFilter = home.filters.Dispatch(null, i);
      const dispatches = await home.queryFilter(dispatchFilter, fromBlock);
      assert(dispatches.length == 1);
      const dispatch = dispatches[0];
      const proof = await home.proof({ blockTag: dispatch.blockNumber });
      const destination = dispatch.args.destinationAndNonce.shr(32);
      const replica = this.replica(destination.toNumber(), local);
      await replica.proveAndProcess(dispatch.args.message, proof, i)
    }
  }
}

export const abacus: any = {
  AbacusDeployment,
};
