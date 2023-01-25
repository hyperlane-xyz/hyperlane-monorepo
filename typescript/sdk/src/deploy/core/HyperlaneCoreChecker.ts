import { utils } from '@hyperlane-xyz/utils';

import { HyperlaneCore } from '../../core/HyperlaneCore';
import { ChainNameToDomainId } from '../../domains';
import { ChainName } from '../../types';
import { HyperlaneAppChecker } from '../HyperlaneAppChecker';

import {
  CoreConfig,
  CoreViolationType,
  EnrolledValidatorsViolation,
  MailboxViolation,
  MailboxViolationType,
  MultisigIsmViolationType,
  ThresholdViolation,
  ValidatorAnnounceViolation,
} from './types';

export class HyperlaneCoreChecker<
  Chain extends ChainName,
> extends HyperlaneAppChecker<Chain, HyperlaneCore<Chain>, CoreConfig> {
  async checkChain(chain: Chain): Promise<void> {
    const config = this.configMap[chain];
    // skip chains that are configured to be removed
    if (config.remove) {
      return;
    }

    await this.checkDomainOwnership(chain);
    await this.checkProxiedContracts(chain);
    await this.checkMailbox(chain);
    await this.checkMultisigIsm(chain);
    await this.checkValidatorAnnounce(chain);
  }

  async checkDomainOwnership(chain: Chain): Promise<void> {
    const config = this.configMap[chain];
    if (config.owner) {
      const contracts = this.app.getContracts(chain);
      const ownables = [
        contracts.proxyAdmin,
        contracts.mailbox.contract,
        contracts.multisigIsm,
      ];
      return this.checkOwnership(chain, config.owner, ownables);
    }
  }

  async checkMailbox(chain: Chain): Promise<void> {
    const contracts = this.app.getContracts(chain);
    const mailbox = contracts.mailbox.contract;
    const localDomain = await mailbox.localDomain();
    utils.assert(localDomain === ChainNameToDomainId[chain]);

    const actualIsm = await mailbox.defaultIsm();
    const expectedIsm = contracts.multisigIsm.address;
    if (actualIsm !== expectedIsm) {
      const violation: MailboxViolation = {
        type: CoreViolationType.Mailbox,
        mailboxType: MailboxViolationType.DefaultIsm,
        contract: mailbox,
        chain,
        actual: actualIsm,
        expected: expectedIsm,
      };
      this.addViolation(violation);
    }
  }

  async checkProxiedContracts(chain: Chain): Promise<void> {
    const contracts = this.app.getContracts(chain);
    await this.checkProxiedContract(
      chain,
      'Mailbox',
      contracts.mailbox.addresses,
      contracts.proxyAdmin.address,
    );
    await this.checkProxiedContract(
      chain,
      'InterchainGasPaymaster',
      contracts.interchainGasPaymaster.addresses,
      contracts.proxyAdmin.address,
    );
    await this.checkProxiedContract(
      chain,
      'DefaultIsmInterchainGasPaymaster',
      contracts.interchainGasPaymaster.addresses,
      contracts.proxyAdmin.address,
    );
  }

  async checkValidatorAnnounce(chain: Chain): Promise<void> {
    const expectedValidators = this.configMap[chain].multisigIsm.validators;
    const validatorAnnounce = this.app.getContracts(chain).validatorAnnounce;
    const announcedValidators =
      await validatorAnnounce.getAnnouncedValidators();
    expectedValidators.map((validator) => {
      if (!announcedValidators.includes(validator)) {
        const violation: ValidatorAnnounceViolation = {
          type: CoreViolationType.ValidatorAnnounce,
          chain,
          validator,
          actual: false,
          expected: true,
        };
        this.addViolation(violation);
      }
    });
  }

  async checkMultisigIsm(local: Chain): Promise<void> {
    await Promise.all(
      this.app
        .remoteChains(local)
        .map((remote) => this.checkMultisigIsmForRemote(local, remote)),
    );
  }

  async checkMultisigIsmForRemote(local: Chain, remote: Chain): Promise<void> {
    const coreContracts = this.app.getContracts(local);
    const multisigIsm = coreContracts.multisigIsm;
    const config = this.configMap[remote];

    const remoteDomain = ChainNameToDomainId[remote];
    const multisigIsmConfig = config.multisigIsm;
    const expectedValidators = multisigIsmConfig.validators;
    const actualValidators = await multisigIsm.validators(remoteDomain);

    const expectedSet = new Set<string>(
      expectedValidators.map((_) => _.toLowerCase()),
    );
    const actualSet = new Set<string>(
      actualValidators.map((_) => _.toLowerCase()),
    );

    if (!utils.setEquality(expectedSet, actualSet)) {
      const violation: EnrolledValidatorsViolation = {
        type: CoreViolationType.MultisigIsm,
        subType: MultisigIsmViolationType.EnrolledValidators,
        contract: multisigIsm,
        chain: local,
        remote,
        actual: actualSet,
        expected: expectedSet,
      };
      this.addViolation(violation);
    }

    const expectedThreshold = multisigIsmConfig.threshold;
    utils.assert(expectedThreshold !== undefined);

    const actualThreshold = await multisigIsm.threshold(remoteDomain);

    if (expectedThreshold !== actualThreshold) {
      const violation: ThresholdViolation = {
        type: CoreViolationType.MultisigIsm,
        subType: MultisigIsmViolationType.Threshold,
        contract: multisigIsm,
        chain: local,
        remote,
        actual: actualThreshold,
        expected: expectedThreshold,
      };
      this.addViolation(violation);
    }
  }
}
