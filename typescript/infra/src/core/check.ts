import { MultisigValidatorManager } from '@abacus-network/core';
import { AbacusAppChecker, CheckerViolation } from '@abacus-network/deploy';
import { AbacusCore, CoreDeployedNetworks, Mailbox } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';
import { expect } from 'chai';
import { setDifference } from '../utils/utils';
import { CoreConfig } from './types';

export enum CoreViolationType {
  ValidatorManager = 'ValidatorManager',
  Validator = 'Validator',
}

export enum ValidatorViolationType {
  EnrollValidator = 'EnrollValidator',
  UnenrollValidator = 'UnenrollValidator',
  Threshold = 'Threshold',
}

export interface ValidatorManagerViolation extends CheckerViolation {
  type: CoreViolationType.ValidatorManager;
}

export interface ValidatorViolation extends CheckerViolation {
  type: CoreViolationType.Validator;
  data: {
    type: ValidatorViolationType;
    validatorManagerAddress: string;
  };
}

export class AbacusCoreChecker extends AbacusAppChecker<
  CoreDeployedNetworks,
  AbacusCore,
  CoreConfig<CoreDeployedNetworks>
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
    await this.checkDomainOwnership(domain, owner);
    await this.checkProxiedContracts(domain);
    await this.checkOutbox(domain);
    await this.checkInboxes(domain);
    await this.checkAbacusConnectionManager(domain);
    await this.checkValidatorManagers(domain);
  }

  async checkDomainOwnership(
    domain: types.Domain,
    owner: types.Address,
  ): Promise<void> {
    const contracts = this.app.mustGetContracts(domain);
    const owners = [
      contracts.abacusConnectionManager.owner(),
      contracts.upgradeBeaconController.owner(),
      contracts.outbox.owner(),
      contracts.outboxValidatorManager.owner(),
    ];
    this.app.remoteDomainNumbers(domain).map((remote) => {
      owners.push(this.app.mustGetInbox(remote, domain).owner());
      owners.push(
        this.app.mustGetInboxValidatorManager(remote, domain).owner(),
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
    const expectedManager = contracts.outboxValidatorManager.address;
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

  // Checks validator sets of the OutboxValidatorManager and all
  // InboxValidatorManagers on the domain.
  async checkValidatorManagers(domain: types.Domain): Promise<void> {
    const promises = this.app.domainNumbers.map((outboxDomain: number) => {
      let validatorManager: MultisigValidatorManager;
      // Check the OutboxValidatorManager
      if (domain === outboxDomain) {
        validatorManager =
          this.app.mustGetContracts(domain).outboxValidatorManager;
      } else {
        // Check an InboxValidatorManager
        validatorManager = this.app.mustGetInboxValidatorManager(
          outboxDomain,
          domain,
        );
      }
      return this.checkValidatorManager(domain, outboxDomain, validatorManager);
    });

    await Promise.all(promises);
  }

  // Checks the validator set for a MultisigValidatorManager on the localDomain that tracks
  // the validator set for the outboxDomain.
  // If localDomain == outboxDomain, this checks the OutboxValidatorManager, otherwise
  // it checks an InboxValidatorManager.
  async checkValidatorManager(
    localDomain: types.Domain,
    outboxDomain: types.Domain,
    validatorManager: MultisigValidatorManager,
  ): Promise<void> {
    const outboxDomainName = this.app.mustResolveDomainName(outboxDomain);
    const validatorManagerConfig =
      this.config.validatorManagers[outboxDomainName as CoreDeployedNetworks];
    expect(validatorManagerConfig).to.not.be.undefined;

    const expectedValidators = validatorManagerConfig?.validators;
    expect(expectedValidators).to.not.be.undefined;

    const actualValidators = await validatorManager.validators();
    expect(actualValidators).to.not.be.undefined;

    const expectedSet = new Set<string>(expectedValidators);
    const actualSet = new Set<string>(actualValidators);

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
          type: ValidatorViolationType.EnrollValidator,
          validatorManagerAddress: validatorManager.address,
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
          type: ValidatorViolationType.UnenrollValidator,
          validatorManagerAddress: validatorManager.address,
        },
      };
      this.addViolation(violation);
    }

    const expectedThreshold = validatorManagerConfig?.threshold;
    expect(expectedThreshold).to.not.be.undefined;

    const actualThreshold = await validatorManager.threshold();

    if (expectedThreshold !== actualThreshold.toNumber()) {
      const violation: ValidatorViolation = {
        domain: localDomain,
        type: CoreViolationType.Validator,
        actual: actualThreshold,
        expected: expectedThreshold,
        data: {
          type: ValidatorViolationType.Threshold,
          validatorManagerAddress: validatorManager.address,
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
        const expectedValidatorManager = this.app.mustGetInboxValidatorManager(
          remote,
          domain,
        );
        expect(
          await this.app.mustGetInbox(remote, domain).validatorManager(),
        ).to.equal(expectedValidatorManager.address);
      }),
    );

    // Check that all inboxes on this domain share the same implementation and
    // UpgradeBeacon.
    const inboxes: Mailbox[] = Object.values(contracts.addresses.inboxes);
    const implementations = inboxes.map((r) => r.implementation);
    const identical = (a: any, b: any) => (a === b ? a : false);
    const upgradeBeacons = inboxes.map((r) => r.beacon);
    expect(implementations.reduce(identical)).to.not.be.false;
    expect(upgradeBeacons.reduce(identical)).to.not.be.false;
  }

  async checkAbacusConnectionManager(domain: types.Domain): Promise<void> {
    const contracts = this.app.mustGetContracts(domain);
    for (const remote of this.app.remoteDomainNumbers(domain)) {
      // inbox is enrolled in abacusConnectionManager
      const enrolledInbox =
        await contracts.abacusConnectionManager.domainToInbox(remote);
      expect(enrolledInbox).to.equal(
        this.app.mustGetInbox(remote, domain).address,
      );
    }
    // Outbox is set on abacusConnectionManager
    const outbox = await contracts.abacusConnectionManager.outbox();
    expect(outbox).to.equal(contracts.outbox.address);
  }

  async checkProxiedContracts(domain: types.Domain): Promise<void> {
    const addresses = this.app.mustGetContracts(domain).addresses;
    // Outbox upgrade setup contracts are defined
    await this.checkUpgradeBeacon(domain, 'Outbox', addresses.outbox);

    const inboxes: Mailbox[] = Object.values(addresses.inboxes);
    await Promise.all(
      inboxes.map((inbox) => {
        return this.checkUpgradeBeacon(domain, 'Inbox', inbox);
      }),
    );
  }
}
