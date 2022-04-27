import { MultisigValidatorManager } from '@abacus-network/core';
import { AbacusAppChecker, CheckerViolation } from '@abacus-network/deploy';
import {
  AbacusCore,
  ChainName,
  ChainSubsetMap,
  CoreContractAddresses,
  domains,
  MailboxAddresses,
  utils,
} from '@abacus-network/sdk';
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

export class AbacusCoreChecker<
  Networks extends ChainName,
> extends AbacusAppChecker<
  Networks,
  AbacusCore<Networks>,
  CoreConfig<Networks>
> {
  async check(
    owners: ChainSubsetMap<Networks, types.Address>,
    networkAddresses: ChainSubsetMap<
      Networks,
      CoreContractAddresses<Networks, any>
    >,
  ) {
    return Promise.all(
      this.app
        .networks()
        .map((network) =>
          this.checkDomain(network, owners[network], networkAddresses[network]),
        ),
    );
  }

  async checkDomain(
    network: Networks,
    owner: types.Address,
    addresses: CoreContractAddresses<Networks, any>,
  ): Promise<void> {
    await this.checkDomainOwnership(network, owner);
    await this.checkProxiedContracts(network, addresses);
    await this.checkOutbox(network);
    await this.checkInboxes(network, addresses);
    await this.checkAbacusConnectionManager(network);
    await this.checkValidatorManagers(network);
  }

  async checkDomainOwnership(
    network: Networks,
    owner: types.Address,
  ): Promise<void> {
    const contracts = this.app.getContracts(network).contracts;
    const ownables = [
      contracts.abacusConnectionManager,
      contracts.upgradeBeaconController,
      contracts.outbox.outbox,
      contracts.outbox.validatorManager,
      ...Object.values(contracts.inboxes)
        .map((inbox: any) => [inbox.inbox, inbox.validatorManager])
        .flat(),
    ];
    return this.checkOwnership(owner, ownables);
  }

  async checkOutbox(network: Networks): Promise<void> {
    const contracts = this.app.getContracts(network).contracts;
    const actualManager = await contracts.outbox.outbox.validatorManager();
    const expectedManager = contracts.outbox.validatorManager.address;
    if (actualManager !== expectedManager) {
      const violation: ValidatorManagerViolation = {
        network,
        type: CoreViolationType.ValidatorManager,
        actual: actualManager,
        expected: expectedManager,
      };
      this.addViolation(violation);
    }
  }

  // Checks validator sets of the OutboxValidatorManager and all
  // InboxValidatorManagers on the domain.
  async checkValidatorManagers(network: Networks) {
    const coreContracts = this.app.getContracts(network).contracts;
    await this.checkValidatorManager(
      network,
      network,
      coreContracts.outbox.validatorManager,
    );
    return utils.promiseObjAll<Record<any, void>>(
      utils.objMap(coreContracts.inboxes, (remote, inbox) =>
        this.checkValidatorManager(network, remote, inbox.validatorManager),
      ),
    );
  }

  // Checks the validator set for a MultisigValidatorManager on the localDomain that tracks
  // the validator set for the outboxDomain.
  // If localDomain == outboxDomain, this checks the OutboxValidatorManager, otherwise
  // it checks an InboxValidatorManager.
  async checkValidatorManager(
    local: Networks,
    remote: Networks,
    validatorManager: MultisigValidatorManager,
  ): Promise<void> {
    const validatorManagerConfig = this.config.validatorManagers[remote];
    const expectedValidators = validatorManagerConfig.validators;
    const actualValidators = await validatorManager.validators();

    const expectedSet = new Set<string>(expectedValidators);
    const actualSet = new Set<string>(actualValidators);

    const toEnroll = setDifference(expectedSet, actualSet);
    const toUnenroll = setDifference(actualSet, expectedSet);

    // Validators that should be enrolled
    for (const validatorToEnroll of toEnroll) {
      const violation: ValidatorViolation = {
        network: local,
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
        network: local,
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

    const expectedThreshold = validatorManagerConfig.threshold;
    expect(expectedThreshold).to.not.be.undefined;

    const actualThreshold = await validatorManager.threshold();

    if (expectedThreshold !== actualThreshold.toNumber()) {
      const violation: ValidatorViolation = {
        network: local,
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

  async checkInboxes(
    network: Networks,
    addresses: CoreContractAddresses<Networks, any>,
  ): Promise<void> {
    const coreContracts = this.app.getContracts(network);

    // Check that all inboxes on this domain are pointed to the right validator
    // manager.
    await utils.promiseObjAll(
      utils.objMap(coreContracts.contracts.inboxes, async (_, inbox) => {
        const expected = inbox.validatorManager.address;
        const actual = await inbox.inbox.validatorManager();
        expect(actual).to.equal(expected);
      }),
    );

    // Check that all inboxes on this domain share the same implementation and
    // UpgradeBeacon.
    const inboxes: MailboxAddresses[] = Object.values(addresses.inboxes);
    const implementations = inboxes.map((r) => r.implementation);
    const identical = (a: any, b: any) => (a === b ? a : false);
    const upgradeBeacons = inboxes.map((r) => r.beacon);
    expect(implementations.reduce(identical)).to.not.be.false;
    expect(upgradeBeacons.reduce(identical)).to.not.be.false;
  }

  async checkAbacusConnectionManager(network: Networks): Promise<void> {
    const coreContracts = this.app.getContracts(network).contracts;

    const outbox = await coreContracts.abacusConnectionManager.outbox();
    expect(outbox).to.equal(coreContracts.outbox.outbox.address);

    await utils.promiseObjAll(
      utils.objMap(coreContracts.inboxes, async (remote, inbox) => {
        const domain = domains[remote].id;
        const enrolledInbox =
          await coreContracts.abacusConnectionManager.domainToInbox(domain);
        expect(enrolledInbox).to.equal(inbox.inbox.address);
      }),
    );
  }

  async checkProxiedContracts(
    network: Networks,
    addresses: CoreContractAddresses<Networks, any>,
  ): Promise<void> {
    // Outbox upgrade setup contracts are defined
    await this.checkUpgradeBeacon(network, 'Outbox', addresses.outbox);
    const inboxes: MailboxAddresses[] = Object.values(addresses.inboxes);
    await Promise.all(
      inboxes.map((inbox) => {
        return this.checkUpgradeBeacon(network, 'Inbox', inbox);
      }),
    );
  }
}
