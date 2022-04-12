import { expect } from 'chai';
import { MultisigValidatorManager } from '@abacus-network/core';
import { types } from '@abacus-network/utils';
import { AbacusCore } from '@abacus-network/sdk';
import { AbacusAppChecker, CheckerViolation } from '@abacus-network/deploy';
import { CoreConfig } from './types';
import { setDifference } from '../utils/utils';

export enum CoreViolationType {
  ValidatorManager = 'ValidatorManager',
  Validator = 'Validator',
}

export interface ValidatorManagerViolation extends CheckerViolation {
  type: CoreViolationType.ValidatorManager;
}

export interface ValidatorViolation extends CheckerViolation {
  type: CoreViolationType.Validator;
  data: {
    multisigValidatorManagerAddress: string;
  };
}

export class AbacusCoreChecker extends AbacusAppChecker<
  AbacusCore,
  CoreConfig
> {
  async check(
    owners: Partial<Record<types.Domain, types.Address>>,
  ): Promise<void> {
    await Promise.all(
      this.app.domainNumbers.map((domain: types.Domain) => {
        const owner = owners[domain];
        if (!owner) throw new Error('owner not found');
        return this.checkDomain(domain, owner);
      }),
    );
  }

  async checkDomain(domain: types.Domain, owner: types.Address): Promise<void> {
    await this.checkOwnership(domain, owner);
    await this.checkProxiedContracts(domain);
    await this.checkOutbox(domain);
    await this.checkInboxes(domain);
    await this.checkXAppConnectionManager(domain);
    await this.checkMultisigValidatorManagers(domain);
  }

  async checkOwnership(
    domain: types.Domain,
    owner: types.Address,
  ): Promise<void> {
    const contracts = this.app.mustGetContracts(domain);
    const owners = [
      contracts.xAppConnectionManager.owner(),
      contracts.upgradeBeaconController.owner(),
      contracts.outbox.owner(),
      contracts.outboxMultisigValidatorManager.owner(),
    ];
    this.app.remoteDomainNumbers(domain).map((remote) => {
      owners.push(this.app.mustGetInbox(remote, domain).owner());
      owners.push(
        this.app.mustGetInboxMultisigValidatorManager(remote, domain).owner(),
      );
    });
    const actual = await Promise.all(owners);
    actual.map((_) => expect(_).to.equal(owner));
  }

  async checkOutbox(domain: types.Domain): Promise<void> {
    const contracts = this.app.mustGetContracts(domain);
    const outbox = contracts.outbox;
    // validatorManager is set on Outbox
    const actualManager = await outbox.validatorManager();
    const expectedManager = contracts.outboxMultisigValidatorManager.address;
    if (actualManager !== expectedManager) {
      const violation: ValidatorManagerViolation = {
        domain,
        type: CoreViolationType.ValidatorManager,
        actual: actualManager,
        expected: expectedManager,
      };
      this.addViolation(violation);
    }
  }

  // Checks validator sets of the OutboxMultisigValidatorManager and all
  // InboxMultisigValidatorManagers on the domain.
  async checkMultisigValidatorManagers(domain: types.Domain): Promise<void> {
    const promises = this.app.domainNumbers.map((outboxDomain: number) => {
      let multisigValidatorManager: MultisigValidatorManager;
      // Check the outboxMultisigValidatorManager
      if (domain === outboxDomain) {
        multisigValidatorManager =
          this.app.mustGetContracts(domain).outboxMultisigValidatorManager;
      } else {
        // Check an inboxMultisigValidatorManager
        multisigValidatorManager =
          this.app.mustGetInboxMultisigValidatorManager(outboxDomain, domain);
      }
      return this.checkMultisigValidatorManager(
        domain,
        outboxDomain,
        multisigValidatorManager,
      );
    });

    await Promise.all(promises);
  }

  // Checks the validator set for a MultisigValidatorManager on the localDomain that tracks
  // the validator set for the outboxDomain.
  // If localDomain == outboxDomain, this checks the OutboxMultisigValidatorManager, otherwise
  // it checks an InboxMultisigValidatorManager.
  async checkMultisigValidatorManager(
    localDomain: types.Domain,
    outboxDomain: types.Domain,
    multisigValidatorManager: MultisigValidatorManager,
  ): Promise<void> {
    const outboxDomainName = this.app.mustResolveDomainName(outboxDomain);
    const expected =
      this.config.multisigValidatorManagers[outboxDomainName]?.validatorSet;
    expect(expected).to.not.be.undefined;

    const actual = await multisigValidatorManager.validatorSet();
    expect(actual).to.not.be.undefined;

    const expectedSet = new Set<string>(expected);
    const actualSet = new Set<string>(actual);

    const toEnroll = setDifference(expectedSet, actualSet);
    const toUnenroll = setDifference(actualSet, expectedSet);

    // Validators that should be enrolled
    for (const validatorToEnroll of toEnroll) {
      const violation: ValidatorViolation = {
        domain: localDomain,
        type: CoreViolationType.Validator,
        actual: undefined,
        expected: validatorToEnroll,
        data: {
          multisigValidatorManagerAddress: multisigValidatorManager.address,
        },
      };
      this.addViolation(violation);
    }

    // Validators that should be unenrolled
    for (const validatorToUnenroll of toUnenroll) {
      const violation: ValidatorViolation = {
        domain: localDomain,
        type: CoreViolationType.Validator,
        actual: validatorToUnenroll,
        expected: undefined,
        data: {
          multisigValidatorManagerAddress: multisigValidatorManager.address,
        },
      };
      this.addViolation(violation);
    }
  }

  async checkInboxes(domain: types.Domain): Promise<void> {
    // Check that all inboxes on this domain are pointed to the right validator
    // manager.
    const contracts = this.app.mustGetContracts(domain);

    await Promise.all(
      this.app.remoteDomainNumbers(domain).map(async (remote) => {
        const expectedValidatorManager = this.app.mustGetInboxMultisigValidatorManager(remote, domain);
        expect(
          await this.app.mustGetInbox(remote, domain).validatorManager(),
        ).to.equal(expectedValidatorManager.address);
      }),
    );

    // Check that all inboxes on this domain share the same implementation and
    // UpgradeBeacon.
    const inboxes = Object.values(contracts.addresses.inboxes);
    const implementations = inboxes.map((r) => r.implementation);
    const identical = (a: any, b: any) => (a === b ? a : false);
    const upgradeBeacons = inboxes.map((r) => r.beacon);
    expect(implementations.reduce(identical)).to.not.be.false;
    expect(upgradeBeacons.reduce(identical)).to.not.be.false;
  }

  async checkXAppConnectionManager(domain: types.Domain): Promise<void> {
    const contracts = this.app.mustGetContracts(domain);
    for (const remote of this.app.remoteDomainNumbers(domain)) {
      // inbox is enrolled in xAppConnectionManager
      const enrolledInbox = await contracts.xAppConnectionManager.domainToInbox(
        remote,
      );
      expect(enrolledInbox).to.equal(
        this.app.mustGetInbox(remote, domain).address,
      );
    }
    // Outbox is set on xAppConnectionManager
    const outbox = await contracts.xAppConnectionManager.outbox();
    expect(outbox).to.equal(contracts.outbox.address);
  }

  async checkProxiedContracts(domain: types.Domain): Promise<void> {
    const addresses = this.app.mustGetContracts(domain).addresses;
    // Outbox upgrade setup contracts are defined
    await this.checkUpgradeBeacon(domain, 'Outbox', addresses.outbox);

    const inboxes = Object.values(addresses.inboxes);
    await Promise.all(
      inboxes.map((inbox) => {
        return this.checkUpgradeBeacon(domain, 'Inbox', inbox);
      }),
    );
  }
}
