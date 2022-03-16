import { expect } from 'chai';
import { types } from '@abacus-network/utils';
import { CoreDeploy } from './CoreDeploy';
import { CoreConfig } from './types';
import {
  ViolationType,
  ValidatorViolation,
  ValidatorManagerViolation,
  CommonInvariantChecker,
} from '../common';

export class CoreInvariantChecker extends CommonInvariantChecker<
  CoreDeploy,
  CoreConfig
> {
  async checkDomain(domain: types.Domain): Promise<void> {
    this.checkContractsDefined(domain);
    await this.checkOwnership(domain);
    await this.checkBeaconProxies(domain);
    await this.checkOutbox(domain);
    await this.checkInboxes(domain);
    await this.checkXAppConnectionManager(domain);
    await this.checkValidatorManager(domain);
  }

  checkContractsDefined(domain: types.Domain): void {
    expect(this.deploy.outbox(domain)).to.not.be.undefined;
    expect(this.deploy.upgradeBeaconController(domain)).to.not.be.undefined;
    expect(this.deploy.xAppConnectionManager(domain)).to.not.be.undefined;
    expect(this.deploy.validatorManager(domain)).to.not.be.undefined;
    for (const remote of this.deploy.remotes(domain)) {
      expect(this.deploy.inbox(domain, remote)).to.not.be.undefined;
    }
  }

  async checkOwnership(domain: types.Domain): Promise<void> {
    const owners = [
      this.deploy.validatorManager(domain).owner(),
      this.deploy.xAppConnectionManager(domain).owner(),
      this.deploy.upgradeBeaconController(domain).owner(),
      this.deploy.outbox(domain).owner(),
    ];
    this.deploy.remotes(domain).map((remote) => {
      owners.push(this.deploy.inbox(domain, remote).owner());
    });
    const actual = await Promise.all(owners);
    const expected = this.owners[domain];
    actual.map((_) => expect(_).to.equal(expected));
  }

  async checkOutbox(domain: types.Domain): Promise<void> {
    const outbox = this.deploy.outbox(domain);
    // validatorManager is set on Outbox
    const actualManager = await outbox.validatorManager();
    const expectedManager = this.deploy.validatorManager(domain).address;
    if (actualManager !== expectedManager) {
      const violation: ValidatorManagerViolation = {
        domain: domain,
        type: ViolationType.ValidatorManager,
        actual: actualManager,
        expected: expectedManager,
      };
      this.addViolation(violation);
    }
  }

  async checkValidatorManager(domain: types.Domain): Promise<void> {
    const manager = this.deploy.validatorManager(domain);

    for (const d of this.deploy.domains) {
      const expected = this.config.validators[this.deploy.chains[d].name];
      const actual = await manager.validators(d);
      expect(actual).to.not.be.undefined;
      if (actual !== expected) {
        const violation: ValidatorViolation = {
          local: domain,
          remote: d,
          type: ViolationType.Validator,
          actual,
          expected,
        };
        this.addViolation(violation);
      }
    }
  }

  async checkInboxes(domain: types.Domain): Promise<void> {
    const remotes = this.deploy.remotes(domain);
    // Check that all inboxes on this domain are pointed to the right validator
    // manager.
    for (const remote of remotes) {
      expect(
        await this.deploy.inbox(domain, remote).validatorManager(),
      ).to.equal(this.deploy.validatorManager(domain).address);
    }
    if (remotes.length > 0) {
      // Check that all inboxes on this domain share the same implementation and
      // UpgradeBeacon.
      const inboxes = Object.values(
        this.deploy.instances[domain].contracts.inboxes,
      );
      const implementations = inboxes.map((r) => r.implementation.address);
      const identical = (a: any, b: any) => (a === b ? a : false);
      const upgradeBeacons = inboxes.map((r) => r.beacon.address);
      expect(implementations.reduce(identical)).to.not.be.false;
      expect(upgradeBeacons.reduce(identical)).to.not.be.false;
    }
  }

  async checkXAppConnectionManager(domain: types.Domain): Promise<void> {
    expect(this.deploy.xAppConnectionManager(domain)).to.not.be.undefined;
    for (const remote of this.deploy.remotes(domain)) {
      // inbox is enrolled in xAppConnectionManager
      const enrolledInbox = await this.deploy
        .xAppConnectionManager(domain)
        .domainToInbox(remote);
      expect(enrolledInbox).to.equal(this.deploy.inbox(domain, remote).address);
    }
    // Outbox is set on xAppConnectionManager
    const outbox = await this.deploy.xAppConnectionManager(domain).outbox();
    expect(outbox).to.equal(this.deploy.outbox(domain).address);
  }

  async checkBeaconProxies(domain: types.Domain): Promise<void> {
    // Outbox upgrade setup contracts are defined
    await this.checkBeaconProxyImplementation(
      domain,
      'Outbox',
      this.deploy.instances[domain].contracts.outbox,
    );

    await Promise.all(
      this.deploy
        .remotes(domain)
        .map((remote) =>
          this.checkBeaconProxyImplementation(
            domain,
            'Inbox',
            this.deploy.instances[domain].contracts.inboxes[remote],
          ),
        ),
    );
  }
}
