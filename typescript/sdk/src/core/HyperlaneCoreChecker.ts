import { utils as ethersUtils } from 'ethers';

import { utils } from '@hyperlane-xyz/utils';

import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker';
import { ChainName } from '../types';

import { HyperlaneCore } from './HyperlaneCore';
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

const MAILBOX_WITHOUT_LOCAL_DOMAIN_BYTE_CODE_HASH =
  '0x29b7294ab3ad2e8587e5cce0e2289ce65e12a2ea2f1e7ab34a05e7737616f457';
const MAILBOX_WITHOUT_LOCAL_DOMAIN_NONZERO_PAUSE_BYTE_CODE_HASH =
  '0x4e73e34c0982b93eebb4ac4889e9e4e1611f7c24feacf016c3a13e389f146d9c';
const TRANSPARENT_PROXY_BYTECODE_HASH =
  '0x4dde3d0906b6492bf1d4947f667afe8d53c8899f1d8788cabafd082938dceb2d';
const MULTISIG_ISM_BYTECODE_HASH =
  '0x5565704ffa5b10fdf37d57abfddcf137101d5fb418ded21fa6c5f90262c57dc2';
const PROXY_ADMIN_BYTECODE_HASH =
  '0x7c378e9d49408861ca754fe684b9f7d1ea525bddf095ee0463902df701453ba0';

export class HyperlaneCoreChecker extends HyperlaneAppChecker<
  HyperlaneCore,
  CoreConfig
> {
  async checkChain(chain: ChainName): Promise<void> {
    const config = this.configMap[chain];
    // skip chains that are configured to be removed
    if (config.remove) {
      return;
    }

    await this.checkDomainOwnership(chain);
    await this.checkProxiedContracts(chain);
    await this.checkMailbox(chain);
    await this.checkMultisigIsm(chain);
    await this.checkBytecodes(chain);
    await this.checkValidatorAnnounce(chain);
  }

  async checkDomainOwnership(chain: ChainName): Promise<void> {
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

  async checkMailbox(chain: ChainName): Promise<void> {
    const contracts = this.app.getContracts(chain);
    const mailbox = contracts.mailbox.contract;
    const localDomain = await mailbox.localDomain();
    utils.assert(localDomain === this.multiProvider.getDomainId(chain));

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

  async checkBytecodes(chain: ChainName): Promise<void> {
    const contracts = this.app.getContracts(chain);
    const mailbox = contracts.mailbox.contract;
    const localDomain = await mailbox.localDomain();

    await this.checkBytecode(
      chain,
      'Mailbox implementation',
      contracts.mailbox.addresses.implementation,
      [
        MAILBOX_WITHOUT_LOCAL_DOMAIN_BYTE_CODE_HASH,
        MAILBOX_WITHOUT_LOCAL_DOMAIN_NONZERO_PAUSE_BYTE_CODE_HASH,
      ],
      (_) =>
        // This is obviously super janky but basically we are searching
        //  for the ocurrences of localDomain in the bytecode and remove
        //  that to compare, but some coincidental ocurrences of
        // localDomain in the bytecode should be not be removed which
        // are just done via an offset guard
        _.replaceAll(
          ethersUtils.defaultAbiCoder
            .encode(['uint32'], [localDomain])
            .slice(2),
          (match, offset) => (offset > 8000 ? match : ''),
        ),
    );

    await this.checkBytecode(
      chain,
      'Mailbox proxy',
      contracts.mailbox.address,
      [TRANSPARENT_PROXY_BYTECODE_HASH],
    );
    await this.checkBytecode(
      chain,
      'ProxyAdmin',
      contracts.proxyAdmin.address,
      [PROXY_ADMIN_BYTECODE_HASH],
    );
    await this.checkBytecode(
      chain,
      'MultisigIsm implementation',
      contracts.multisigIsm.address,
      [MULTISIG_ISM_BYTECODE_HASH],
    );
  }

  async checkProxiedContracts(chain: ChainName): Promise<void> {
    const contracts = this.app.getContracts(chain);
    await this.checkProxiedContract(
      chain,
      'Mailbox',
      contracts.mailbox.addresses,
      contracts.proxyAdmin.address,
    );
  }

  async checkValidatorAnnounce(chain: ChainName): Promise<void> {
    const expectedValidators = this.configMap[chain].multisigIsm.validators;
    const validatorAnnounce = this.app.getContracts(chain).validatorAnnounce;
    const announcedValidators =
      await validatorAnnounce.getAnnouncedValidators();
    expectedValidators.map((validator) => {
      const matches = announcedValidators.filter((x) =>
        utils.eqAddress(x, validator),
      );
      if (matches.length == 0) {
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

  async checkMultisigIsm(local: ChainName): Promise<void> {
    await Promise.all(
      this.app
        .remoteChains(local)
        .map((remote) => this.checkMultisigIsmForRemote(local, remote)),
    );
  }

  async checkMultisigIsmForRemote(
    local: ChainName,
    remote: ChainName,
  ): Promise<void> {
    const coreContracts = this.app.getContracts(local);
    const multisigIsm = coreContracts.multisigIsm;
    const config = this.configMap[remote];

    const remoteDomain = this.multiProvider.getDomainId(remote);
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
