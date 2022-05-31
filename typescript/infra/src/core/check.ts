import { expect } from 'chai';

import { MultisigValidatorManager } from '@abacus-network/core';
import {
  AbacusAppChecker,
  CheckerViolation,
  CoreConfig,
} from '@abacus-network/deploy';
import {
  AbacusCore,
  ChainName,
  chainMetadata,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';

import { setDifference } from '../utils/utils';

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
  Chain extends ChainName,
> extends AbacusAppChecker<Chain, AbacusCore<Chain>, CoreConfig> {
  async checkChain(chain: Chain): Promise<void> {
    // await this.checkDomainOwnership(chain);
    // await this.checkProxiedContracts(chain);
    await this.checkOutbox(chain);
    await this.checkInboxes(chain);
    await this.checkAbacusConnectionManager(chain);
    await this.checkValidatorManagers(chain);
  }

  // async checkDomainOwnership(chain: Chain): Promise<void> {
  //   const config = this.configMap[chain];
  //   const contracts = this.app.getContracts(chain);
  //   const ownables = [
  //     contracts.abacusConnectionManager,
  //     contracts.upgradeBeaconController,
  //     contracts.outbox.outbox,
  //     contracts.outbox.outboxValidatorManager,
  //     ...Object.values(contracts.inboxes)
  //       .map((inbox: any) => [inbox.inbox, inbox.validatorManager])
  //       .flat(),
  //   ];
  //   return AbacusAppChecker.checkOwnership(config.owner, ownables);
  // }

  async checkOutbox(chain: Chain): Promise<void> {
    const contracts = this.app.getContracts(chain);
    const actualManager = await contracts.outbox.outbox.validatorManager();
    const expectedManager = contracts.outbox.outboxValidatorManager.address;
    if (actualManager !== expectedManager) {
      const violation: ValidatorManagerViolation = {
        chain,
        type: CoreViolationType.ValidatorManager,
        actual: actualManager,
        expected: expectedManager,
      };
      this.addViolation(violation);
    }
  }

  // Checks validator sets of the OutboxValidatorManager and all
  // InboxValidatorManagers on the chain.
  async checkValidatorManagers(chain: Chain) {
    const coreContracts = this.app.getContracts(chain);
    await this.checkValidatorManager(
      chain,
      chain,
      coreContracts.outbox.outboxValidatorManager,
    );
    return promiseObjAll(
      objMap(coreContracts.inboxes, (remote, inbox) =>
        this.checkValidatorManager(chain, remote, inbox.inboxValidatorManager),
      ),
    );
  }

  // Checks the validator set for a MultisigValidatorManager on the localDomain that tracks
  // the validator set for the outboxDomain.
  // If localDomain == outboxDomain, this checks the OutboxValidatorManager, otherwise
  // it checks an InboxValidatorManager.
  async checkValidatorManager(
    local: Chain,
    remote: Chain,
    validatorManager: MultisigValidatorManager,
  ): Promise<void> {
    const config = this.configMap[remote];
    const validatorManagerConfig = config.validatorManager;
    const expectedValidators = validatorManagerConfig.validators;
    const actualValidators = await validatorManager.validators();

    const expectedSet = new Set<string>(expectedValidators);
    const actualSet = new Set<string>(actualValidators);

    const toEnroll = setDifference(expectedSet, actualSet);
    const toUnenroll = setDifference(actualSet, expectedSet);

    // Validators that should be enrolled
    for (const validatorToEnroll of toEnroll) {
      const violation: ValidatorViolation = {
        chain: local,
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
        chain: local,
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
        chain: local,
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

  async checkInboxes(chain: Chain): Promise<void> {
    const coreContracts = this.app.getContracts(chain);

    // Check that all inboxes on this chain are pointed to the right validator
    // manager.
    await promiseObjAll(
      objMap(coreContracts.inboxes, async (_, inbox) => {
        const expected = inbox.inboxValidatorManager.address;
        const actual = await inbox.inbox.validatorManager();
        expect(actual).to.equal(expected);
      }),
    );

    // Check that all inboxes on this chain share the same implementation and
    // UpgradeBeacon.
    // const coreAddresses = this.app.getAddresses(chain);
    // const inboxes: MailboxAddresses[] = Object.values(coreAddresses.inboxes);
    // const implementations = inboxes.map((r) => r.implementation);
    // const identical = (a: any, b: any) => (a === b ? a : false);
    // const upgradeBeacons = inboxes.map((r) => r.beacon);
    // expect(implementations.reduce(identical)).to.not.be.false;
    // expect(upgradeBeacons.reduce(identical)).to.not.be.false;
  }

  async checkAbacusConnectionManager(chain: Chain): Promise<void> {
    const coreContracts = this.app.getContracts(chain);
    await promiseObjAll(
      objMap(coreContracts.inboxes, async (remote, inbox) => {
        const remoteDomain = chainMetadata[remote].id;
        // inbox is enrolled in abacusConnectionManager
        const enrolledInboxes =
          await coreContracts.abacusConnectionManager.getInboxes(remoteDomain);
        expect(enrolledInboxes).to.deep.equal([inbox.inbox.address]);
      }),
    );

    // Outbox is set on abacusConnectionManager
    const outbox = await coreContracts.abacusConnectionManager.outbox();
    expect(outbox).to.equal(coreContracts.outbox.outbox.address);
  }

  // async checkProxiedContracts(chain: Chain): Promise<void> {
  //   const addresses = this.app.getAddresses(chain);
  //   await this.checkUpgradeBeacon(chain, 'Outbox', addresses.outbox);
  //   await promiseObjAll(
  //     objMap(addresses.inboxes, (chain, inbox) =>
  //       this.checkUpgradeBeacon(chain, 'Inbox', inbox),
  //     ),
  //   );
  // }
}
