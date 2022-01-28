import { expect } from 'chai';

import { CoreDeploy } from './CoreDeploy';
import {
  assertInvariantViolation,
  checkBeaconProxyImplementation,
  checkVerificationInput,
  InvariantViolationHandler,
} from '../checks';

interface HomeUpdaterViolation {
  type: InvariantViolationType.HomeUpdater,
  home: BeaconProxy<Home>,
  expectedUpdater: string
  actualUpdater: string
}

interface ReplicaUpdaterViolation {
  type: InvariantViolationType.ReplicaUpdater,
  home: BeaconProxy<Replica>,
  expectedUpdater: string
  actualUpdater: string
}

const emptyAddr = '0x' + '00'.repeat(20);

export class CoreInvariantChecker extends InvariantChecker<CoreDeploy> {
  async checkDeploy(deploy: CoreDeploy): Promise<void> {
    await this.checkBeaconProxies(deploy)
    await this.checkHome(deploy)
    await this.checkReplicas(deploy)
    await this.checkGovernance(deploy)
    await this.checkXAppConnectionManager(deploy)
    this.checkVerificationInputs(deploy)
  }

  async checkBeaconProxies(deploy: CoreDeploy): Promise<void> {
    // Home upgrade setup contracts are defined
    await this.checkBeaconProxyImplementation(
      deploy.chain.domain,
      'Home',
      deploy.contracts.upgradeBeaconController!,
      deploy.contracts.home!,
    );

    // GovernanceRouter upgrade setup contracts are defined
    await this.checkBeaconProxyImplementation(
      deploy.chain.domain,
      'Governance',
      deploy.contracts.upgradeBeaconController!,
      deploy.contracts.governance!,
    );

    for (const domain deploy.contracts.replicas) {
      // Replica upgrade setup contracts are defined
      await this.checkBeaconProxyImplementation(
        deploy.chain.domain,
        'Replica',
        deploy.contracts.upgradeBeaconController!,
        deploy.contracts.replicas[domain]!,
      );
    }
  }

  async checkHome(deploy: CoreDeploy): Promise<void> {
    // contracts are defined
    expect(deploy.contracts.home).to.not.be.undefined;
    // updaterManager is set on Home
    const updaterManager = await deploy.contracts.home?.proxy.updaterManager();
    expect(updaterManager).to.equal(deploy.contracts.updaterManager?.address);
  }

  async checkReplicas(deploy: CoreDeploy): Promise<void> {
    const domains = Object.keys(deploy.contracts.replicas)
    if (domains.length > 0) {
      // expect all replicas to have to same implementation and upgradeBeacon
      const firstReplica = deploy.contracts.replicas[domains[0]]!;
      const replicaImpl = firstReplica.implementation.address;
      const replicaBeacon = firstReplica.beacon.address;
      // check every other implementation/beacon matches the first
      domains.slice(1).forEach((domain) => {
        const replica = deploy.contracts.replicas[domain]!;
        expect(replica).to.not.be.undefined;
        const implementation = replica.implementation.address;
        const beacon = replica.beacon.address;
        expect(implementation).to.equal(replicaImpl);
        expect(beacon).to.equal(replicaBeacon);
      });
    }
  }

  async checkGovernance(deploy: CoreDeploy): Promise<void> {
    expect(deploy.contracts.governance).to.not.be.undefined;
    for (const domain in deploy.contracts.replicas) {
      // governanceRouter for each remote domain is registered
      const registeredRouter = await deploy.contracts.governance?.proxy.routers(
        domain,
      );
      expect(registeredRouter).to.not.equal(emptyAddr);
    }

    // governor is set on governor chain, empty on others
    const gov = await deploy.contracts.governance?.proxy.governor();
    const localDomain = await deploy.contracts.home?.proxy.localDomain();
    if (governorDomain == localDomain) {
      expect(gov).to.not.equal(emptyAddr);
    } else {
      expect(gov).to.equal(emptyAddr);
    }
    // governor domain is correct
    expect(await deploy.contracts.governance?.proxy.governorDomain()).to.equal(
      governorDomain,
    );

    const owners = [
      deploy.contracts.updaterManager?.owner(),
      deploy.contracts.xAppConnectionManager?.owner(),
      deploy.contracts.upgradeBeaconController?.owner(),
      deploy.contracts.home?.proxy.owner(),
    ]
    // This bit fails when the replicas don't yet have the owner() function.
    for (const domain in deploy.contracts.replicas) {
      owners.push(deploy.contracts.deplicas[domain].proxy.owner())
    }
    const expectedOwner = deploy.contracts.governance?.proxy.address;
    expectOwnedByGovernance = async (owner: Promise<string>): Promise<void> => {
      expect(await owner).to.equal(expectedOwner);
    }
  }

  async checkXAppConnectionManager(deploy: CoreDeploy): Promise<void> {
    expect(deploy.contracts.xAppConnectionManager).to.not.be.undefined;
    for (const domain in deploy.contracts.replicas) {
      // replica is enrolled in xAppConnectionManager
      const enrolledReplica =
        await deploy.contracts.xAppConnectionManager?.domainToReplica(domain);
      expect(enrolledReplica).to.not.equal(emptyAddr);
      //watchers have permission in xAppConnectionManager
      await Promise.all(
        deploy.config.watchers.map(async (watcher) => {
          const watcherPermissions =
            await deploy.contracts.xAppConnectionManager?.watcherPermission(
              watcher,
              domain,
            );
          expect(watcherPermissions).to.be.true;
        }),
      );
    }
    // Home is set on xAppConnectionManager
    const xAppManagerHome = await deploy.contracts.xAppConnectionManager?.home();
    const homeAddress = deploy.contracts.home?.proxy.address;
    expect(xAppManagerHome).to.equal(homeAddress);
  }

  getVerificationInputs(deploy: CoreDeploy): VerificationInput[] {
    const inputs = [
      [
        'UpgradeBeaconController',
        deploy.contracts.upgradeBeaconController?.address!,
      ],
      [
        'XAppConnectionManager',
        deploy.contracts.xAppConnectionManager?.address!,
      ],
      [
        'UpdaterManager',
        deploy.contracts.updaterManager?.address!,
      ],
    ]
    const addInputsForUpgradableContract = (contract: BeaconProxy<any>, name: string) => {
      inputs.push([`${name} Implementation`, contract.implementation.address])
      inputs.push([`${name} UpgradeBeacon`, contract.beacon.address])
      inputs.push([`${name} Proxy`, contract.proxy.address])
    }
    addInputsForUpgradableContract(deploy.contracts.home, 'Home')
    addInputsForUpgradableContract(deploy.contracts.governance, 'Governance')
    for (const domain in deploy.contracts.replicas) {
      addInputsForUpgradableContract(deploy.contracts.replicas[domain], 'Replica')
    }
    return inputs
  }

  addInvariantViolation(v: InvariantViolation<any>) {
    super(v);
    switch (violation.type) {
      default:
        this.violations.push(v);
    }
  }
}
