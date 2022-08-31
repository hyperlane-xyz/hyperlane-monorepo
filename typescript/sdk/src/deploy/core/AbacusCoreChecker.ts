import { MultisigValidatorManager } from '@abacus-network/core';
import { utils } from '@abacus-network/utils';

import { chainMetadata } from '../../consts/chainMetadata';
import { AbacusCore } from '../../core/AbacusCore';
import { ChainNameToDomainId } from '../../domains';
import { BeaconProxyAddresses } from '../../proxy';
import { ChainName } from '../../types';
import { objMap, promiseObjAll } from '../../utils/objects';
import { AbacusAppChecker } from '../AbacusAppChecker';

import {
  AbacusConnectionManagerViolationType,
  CoreConfig,
  CoreViolationType,
  EnrolledInboxesViolation,
  EnrolledValidatorsViolation,
  MailboxValidatorManagerViolation,
  MailboxViolation,
  MailboxViolationType,
  ThresholdViolation,
  ValidatorManagerViolationType,
} from './types';

export class AbacusCoreChecker<
  Chain extends ChainName,
> extends AbacusAppChecker<Chain, AbacusCore<Chain>, CoreConfig> {
  async checkChain(chain: Chain): Promise<void> {
    const config = this.configMap[chain];
    if (config.remove) {
      return;
    }

    await this.checkDomainOwnership(chain);
    await this.checkProxiedContracts(chain);
    await this.checkOutbox(chain);
    await this.checkInboxes(chain);
    await this.checkAbacusConnectionManager(chain);
    await this.checkValidatorManagers(chain);
    await this.checkInterchainGasPaymaster(chain);
  }

  async checkDomainOwnership(chain: Chain): Promise<void> {
    const config = this.configMap[chain];
    if (config.owner) {
      const contracts = this.app.getContracts(chain);
      const ownables = [
        contracts.abacusConnectionManager,
        contracts.upgradeBeaconController,
        contracts.outbox.contract,
        contracts.outboxValidatorManager,
        ...Object.values(contracts.inboxes)
          .map((inbox: any) => [
            inbox.inbox.contract,
            inbox.inboxValidatorManager,
          ])
          .flat(),
      ];
      return this.checkOwnership(chain, config.owner, ownables);
    }
  }

  async checkOutbox(chain: Chain): Promise<void> {
    const contracts = this.app.getContracts(chain);
    const outbox = contracts.outbox.contract;
    const localDomain = await outbox.localDomain();
    utils.assert(localDomain === ChainNameToDomainId[chain]);

    const actualManager = await contracts.outbox.contract.validatorManager();
    const expectedManager = contracts.outboxValidatorManager.address;
    if (actualManager !== expectedManager) {
      const violation: MailboxViolation = {
        type: CoreViolationType.Mailbox,
        mailboxType: MailboxViolationType.ValidatorManager,
        contract: outbox,
        chain,
        actual: actualManager,
        expected: expectedManager,
      };
      this.addViolation(violation);
    }
  }

  // Checks validator sets of the OutboxValidatorManager and all
  // InboxValidatorManagers on the chain.
  async checkValidatorManagers(chain: Chain): Promise<void> {
    const coreContracts = this.app.getContracts(chain);
    await this.checkValidatorManager(
      chain,
      chain,
      coreContracts.outboxValidatorManager,
    );
    await promiseObjAll(
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

    const expectedSet = new Set<string>(
      expectedValidators.map((_) => _.toLowerCase()),
    );
    const actualSet = new Set<string>(
      actualValidators.map((_) => _.toLowerCase()),
    );

    if (!utils.setEquality(expectedSet, actualSet)) {
      const violation: EnrolledValidatorsViolation = {
        type: CoreViolationType.ValidatorManager,
        validatorManagerType: ValidatorManagerViolationType.EnrolledValidators,
        contract: validatorManager,
        chain: local,
        actual: actualSet,
        expected: expectedSet,
      };
      this.addViolation(violation);
    }

    const expectedThreshold = validatorManagerConfig.threshold;
    utils.assert(expectedThreshold !== undefined);

    const actualThreshold = (await validatorManager.threshold()).toNumber();

    if (expectedThreshold !== actualThreshold) {
      const violation: ThresholdViolation = {
        type: CoreViolationType.ValidatorManager,
        validatorManagerType: ValidatorManagerViolationType.Threshold,
        contract: validatorManager,
        chain: local,
        actual: actualThreshold,
        expected: expectedThreshold,
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
        const actual = await inbox.inbox.contract.validatorManager();
        if (expected !== actual) {
          const violation: MailboxValidatorManagerViolation = {
            type: CoreViolationType.Mailbox,
            mailboxType: MailboxViolationType.ValidatorManager,
            contract: inbox.inbox.contract,
            chain,
            actual,
            expected,
          };
          this.addViolation(violation);
        }
      }),
    );

    await promiseObjAll(
      objMap(coreContracts.inboxes, async (remoteChain, inbox) => {
        // check that the inbox has the right local domain
        const actualLocalDomain = await inbox.inbox.contract.localDomain();
        utils.assert(actualLocalDomain === ChainNameToDomainId[chain]);

        const actualRemoteDomain = await inbox.inbox.contract.remoteDomain();
        utils.assert(actualRemoteDomain === ChainNameToDomainId[remoteChain]);
      }),
    );

    // Check that all inboxes on this chain share the same implementation and
    // UpgradeBeacon.
    const coreAddresses = this.app.getAddresses(chain);
    const inboxes: BeaconProxyAddresses[] = Object.values(
      coreAddresses.inboxes,
    );
    const implementations = inboxes.map((r) => r.implementation);
    const upgradeBeacons = inboxes.map((r) => r.beacon);
    utils.assert(
      implementations.every(
        (implementation) => implementation === implementations[0],
      ),
    );
    utils.assert(
      upgradeBeacons.every((beacon) => beacon === upgradeBeacons[0]),
    );
  }

  async checkAbacusConnectionManager(chain: Chain): Promise<void> {
    const coreContracts = this.app.getContracts(chain);
    await promiseObjAll(
      objMap(coreContracts.inboxes, async (remote, inbox) => {
        // expected configured inboxes for remote on chain
        const remoteConfig = this.configMap[remote];
        const expectedInboxes = new Set(
          remoteConfig.remove ? [] : [inbox.inbox.address],
        );

        // actual configured inboxes for remote on chain
        const remoteDomain = chainMetadata[remote].id;
        const enrolledInboxes = new Set(
          await coreContracts.abacusConnectionManager.getInboxes(remoteDomain),
        );

        if (!utils.setEquality(enrolledInboxes, expectedInboxes)) {
          const violation: EnrolledInboxesViolation = {
            type: CoreViolationType.AbacusConnectionManager,
            abacusConnectionManagerType:
              AbacusConnectionManagerViolationType.EnrolledInboxes,
            remote,
            contract: coreContracts.abacusConnectionManager,
            chain: chain,
            actual: enrolledInboxes,
            expected: expectedInboxes,
          };
          this.violations.push(violation);
        }
      }),
    );

    // Outbox is set on abacusConnectionManager
    const outbox = await coreContracts.abacusConnectionManager.outbox();
    utils.assert(outbox === coreContracts.outbox.address);
  }

  async checkProxiedContracts(chain: Chain): Promise<void> {
    const contracts = this.app.getContracts(chain);
    await this.checkUpgradeBeacon(chain, 'Outbox', contracts.outbox.addresses);
    await promiseObjAll(
      objMap(contracts.inboxes, (_remoteChain, inbox) =>
        this.checkUpgradeBeacon(chain, 'Inbox', inbox.inbox.addresses),
      ),
    );
  }

  async checkInterchainGasPaymaster(chain: Chain): Promise<void> {
    const contracts = this.app.getContracts(chain);
    await this.checkUpgradeBeacon(
      chain,
      'InterchainGasPaymaster',
      contracts.interchainGasPaymaster.addresses,
    );
  }
}
