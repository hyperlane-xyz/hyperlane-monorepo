// @ts-nocheck
import path from 'path';
import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import {
  AbacusCore,
  ChainName,
  CoreContractAddresses,
  ProxiedAddress,
} from '@abacus-network/sdk';
import { AbacusAppDeployer, ProxiedContract } from '@abacus-network/deploy';
import {
  UpgradeBeaconController,
  XAppConnectionManager,
  InboxMultisigValidatorManager,
  InboxMultisigValidatorManager__factory,
  OutboxMultisigValidatorManager,
  OutboxMultisigValidatorManager__factory,
  Inbox,
  UpgradeBeaconController__factory,
  XAppConnectionManager__factory,
  Outbox__factory,
  Inbox__factory,
  InterchainGasPaymaster__factory,
} from '@abacus-network/core';
import { DeployEnvironment, RustConfig } from '../config';
import { CoreConfig, MultisigValidatorManagerConfig } from './types';

export class AbacusCoreDeployer extends AbacusAppDeployer<
  CoreContractAddresses,
  CoreConfig
> {
  multisigValidatorManagerConfig(
    config: CoreConfig,
    domain: types.Domain,
  ): MultisigValidatorManagerConfig {
    const domainName = this.mustResolveDomainName(domain);
    const validatorManagerConfig = config.multisigValidatorManagers[domainName];
    if (!validatorManagerConfig) {
      throw new Error(`No validator manager config for ${domainName}`);
    }
    return validatorManagerConfig;
  }

  async deployContracts(
    domain: types.Domain,
    config: CoreConfig,
  ): Promise<CoreContractAddresses> {
    const overrides = this.getOverrides(domain);
    const signer = this.mustGetSigner(domain);
    const upgradeBeaconController: UpgradeBeaconController =
      await this.deployContract(
        domain,
        'UpgradeBeaconController',
        new UpgradeBeaconController__factory(signer),
      );

    const outboxMultisigValidatorManagerConfig =
      this.multisigValidatorManagerConfig(config, domain);
    const outboxMultisigValidatorManager: OutboxMultisigValidatorManager =
      await this.deployContract(
        domain,
        'OutboxMultisigValidatorManager',
        new OutboxMultisigValidatorManager__factory(signer),
        domain,
        outboxMultisigValidatorManagerConfig.validatorSet,
        outboxMultisigValidatorManagerConfig.quorumThreshold,
      );

    // for (const name of this.domainNames) {
    //   const validator = config.validators[name];
    //   if (!validator) throw new Error(`No validator for ${name}`);
    //   await validatorManager.enrollValidator(
    //     this.resolveDomain(name),
    //     validator,
    //     overrides,
    //   );
    // }

    const outbox = await this.deployProxiedContract(
      domain,
      'Outbox',
      new Outbox__factory(signer),
      upgradeBeaconController.address,
      [domain],
      [outboxMultisigValidatorManager.address],
    );

    const interchainGasPaymaster = await this.deployContract(
      domain,
      'InterchainGasPaymaster',
      new InterchainGasPaymaster__factory(signer),
    );

    const xAppConnectionManager: XAppConnectionManager =
      await this.deployContract(
        domain,
        'XAppConnectionManager',
        new XAppConnectionManager__factory(signer),
      );
    await xAppConnectionManager.setOutbox(outbox.address, overrides);
    await xAppConnectionManager.setInterchainGasPaymaster(
      interchainGasPaymaster.address,
      overrides,
    );

    const inboxMultisigValidatorManagers: Record<
      types.Domain,
      InboxMultisigValidatorManager
    > = {};
    const inboxMultisigValidatorManagerAddresses: Partial<
      Record<ChainName, types.Address>
    > = {};

    const inboxes: Record<types.Domain, ProxiedContract<Inbox>> = {};
    const inboxAddresses: Partial<Record<ChainName, ProxiedAddress>> = {};
    const remotes = this.remoteDomainNumbers(domain);
    for (let i = 0; i < remotes.length; i++) {
      const remote = remotes[i];
      const remoteName = this.mustResolveDomainName(remote);

      const inboxMultisigValidatorManagerConfig =
        this.multisigValidatorManagerConfig(config, remote);
      const inboxMultisigValidatorManager: InboxMultisigValidatorManager =
        await this.deployContract(
          domain,
          'InboxMultisigValidatorManager',
          new InboxMultisigValidatorManager__factory(signer),
          remote,
          inboxMultisigValidatorManagerConfig.validatorSet,
          inboxMultisigValidatorManagerConfig.quorumThreshold,
        );
      inboxMultisigValidatorManagers[remote] = inboxMultisigValidatorManager;
      inboxMultisigValidatorManagerAddresses[remoteName] =
        inboxMultisigValidatorManager.address;

      const initArgs = [
        remote,
        inboxMultisigValidatorManager.address,
        ethers.constants.HashZero,
        0,
      ];
      if (i === 0) {
        inboxes[remote] = await this.deployProxiedContract(
          domain,
          'Inbox',
          new Inbox__factory(signer),
          upgradeBeaconController.address,
          [domain],
          initArgs,
        );
      } else {
        inboxes[remote] = await this.duplicateProxiedContract(
          domain,
          'Inbox',
          inboxes[remotes[0]],
          initArgs,
        );
      }
      inboxAddresses[this.mustResolveDomainName(remote)] =
        inboxes[remote].addresses;

      await xAppConnectionManager.enrollInbox(
        remote,
        inboxes[remote].address,
        overrides,
      );
    }

    const addresses = {
      upgradeBeaconController: upgradeBeaconController.address,
      xAppConnectionManager: xAppConnectionManager.address,
      interchainGasPaymaster: interchainGasPaymaster.address,
      outboxMultisigValidatorManager: outboxMultisigValidatorManager.address,
      inboxMultisigValidatorManagers: inboxMultisigValidatorManagerAddresses,
      outbox: outbox.addresses,
      inboxes: inboxAddresses,
    };
    return addresses;
  }

  writeRustConfigs(environment: DeployEnvironment, directory: string) {
    for (const domain of this.domainNumbers) {
      const name = this.mustResolveDomainName(domain);
      const filepath = path.join(directory, `${name}_config.json`);
      const addresses = this.mustGetAddresses(domain);

      const outbox = {
        address: addresses.outbox.proxy,
        domain: domain.toString(),
        name,
        rpcStyle: 'ethereum',
        connection: {
          type: 'http',
          url: '',
        },
      };

      const rustConfig: RustConfig = {
        environment,
        signers: {},
        replicas: {},
        home: outbox,
        tracing: {
          level: 'debug',
          fmt: 'json',
        },
        db: 'db_path',
      };

      for (const remote of this.remoteDomainNumbers(domain)) {
        const remoteName = this.mustResolveDomainName(remote);
        const remoteAddresses = this.mustGetAddresses(remote);
        const inboxAddress = remoteAddresses.inboxes[name];
        if (!inboxAddress)
          throw new Error(`No inbox for ${domain} on ${remote}`);
        const inbox = {
          address: inboxAddress.proxy,
          domain: remote.toString(),
          name: remoteName,
          rpcStyle: 'ethereum',
          connection: {
            type: 'http',
            url: '',
          },
        };

        rustConfig.replicas[remoteName] = inbox;
      }
      AbacusAppDeployer.writeJson(filepath, rustConfig);
    }
  }

  static async transferOwnership(
    core: AbacusCore,
    owners: Record<types.Domain, types.Address>,
  ) {
    for (const domain of core.domainNumbers) {
      const owner = owners[domain];
      if (!owner) throw new Error(`Missing owner for ${domain}`);
      await AbacusCoreDeployer.transferOwnershipOfDomain(core, domain, owner);
    }
  }

  static async transferOwnershipOfDomain(
    core: AbacusCore,
    domain: types.Domain,
    owner: types.Address,
  ): Promise<ethers.ContractReceipt> {
    const contracts = core.mustGetContracts(domain);
    const overrides = core.getOverrides(domain);
    await contracts.validatorManager.transferOwnership(owner, overrides);
    await contracts.xAppConnectionManager.transferOwnership(owner, overrides);
    await contracts.upgradeBeaconController.transferOwnership(owner, overrides);
    for (const chain of Object.keys(
      contracts.addresses.inboxes,
    ) as ChainName[]) {
      await contracts.inbox(chain).transferOwnership(owner, overrides);
    }
    const tx = await contracts.outbox.transferOwnership(owner, overrides);
    return tx.wait(core.getConfirmations(domain));
  }
}
