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
  InboxValidatorManager,
  InboxValidatorManager__factory,
  OutboxValidatorManager,
  OutboxValidatorManager__factory,
  Inbox,
  UpgradeBeaconController__factory,
  XAppConnectionManager__factory,
  Outbox__factory,
  Inbox__factory,
  InterchainGasPaymaster__factory,
} from '@abacus-network/core';
import { DeployEnvironment, RustConfig } from '../config';
import { CoreConfig, ValidatorManagerConfig } from './types';

export class AbacusCoreDeployer extends AbacusAppDeployer<
  CoreContractAddresses,
  CoreConfig
> {
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

    const outboxValidatorManagerConfig = this.validatorManagerConfig(
      config,
      domain,
    );
    const outboxValidatorManager: OutboxValidatorManager =
      await this.deployContract(
        domain,
        'OutboxValidatorManager',
        new OutboxValidatorManager__factory(signer),
        domain,
        outboxValidatorManagerConfig.validators,
        outboxValidatorManagerConfig.threshold,
      );

    const outbox = await this.deployProxiedContract(
      domain,
      'Outbox',
      new Outbox__factory(signer),
      upgradeBeaconController.address,
      [domain],
      [outboxValidatorManager.address],
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

    const inboxValidatorManagers: Record<types.Domain, InboxValidatorManager> =
      {};
    const inboxValidatorManagerAddresses: Partial<
      Record<ChainName, types.Address>
    > = {};

    const inboxes: Record<types.Domain, ProxiedContract<Inbox>> = {};
    const inboxAddresses: Partial<Record<ChainName, ProxiedAddress>> = {};
    const remotes = this.remoteDomainNumbers(domain);
    for (let i = 0; i < remotes.length; i++) {
      const remote = remotes[i];
      const remoteName = this.mustResolveDomainName(remote);

      const validatorManagerConfig = this.validatorManagerConfig(
        config,
        remote,
      );
      const inboxValidatorManager: InboxValidatorManager =
        await this.deployContract(
          domain,
          'InboxValidatorManager',
          new InboxValidatorManager__factory(signer),
          remote,
          validatorManagerConfig.validators,
          validatorManagerConfig.threshold,
        );
      inboxValidatorManagers[remote] = inboxValidatorManager;
      inboxValidatorManagerAddresses[remoteName] =
        inboxValidatorManager.address;

      const initArgs = [
        remote,
        inboxValidatorManager.address,
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
      outboxValidatorManager: outboxValidatorManager.address,
      inboxValidatorManagers: inboxValidatorManagerAddresses,
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
        addresses: {
          outbox: addresses.outbox.proxy,
        },
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
        inboxes: {},
        outbox,
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

        const inboxValidatorManagerAddress =
          remoteAddresses.inboxValidatorManagers[name];
        if (!inboxValidatorManagerAddress) {
          throw new Error(
            `No inbox validator manager for ${domain} on ${remote}`,
          );
        }

        const inbox = {
          domain: remote.toString(),
          name: remoteName,
          rpcStyle: 'ethereum',
          connection: {
            type: 'http',
            url: '',
          },
          addresses: {
            inbox: inboxAddress.proxy,
            validatorManager: inboxValidatorManagerAddress,
          },
        };

        rustConfig.inboxes[remoteName] = inbox;
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
    await contracts.outboxValidatorManager.transferOwnership(owner, overrides);
    await contracts.xAppConnectionManager.transferOwnership(owner, overrides);
    await contracts.upgradeBeaconController.transferOwnership(owner, overrides);
    for (const chain of Object.keys(
      contracts.addresses.inboxes,
    ) as ChainName[]) {
      await contracts
        .inboxValidatorManager(chain)
        .transferOwnership(owner, overrides);
      await contracts.inbox(chain).transferOwnership(owner, overrides);
    }
    const tx = await contracts.outbox.transferOwnership(owner, overrides);
    return tx.wait(core.getConfirmations(domain));
  }

  validatorManagerConfig(
    config: CoreConfig,
    domain: types.Domain,
  ): ValidatorManagerConfig {
    const domainName = this.mustResolveDomainName(domain);
    const validatorManagerConfig = config.validatorManagers[domainName];
    if (!validatorManagerConfig) {
      throw new Error(`No validator manager config for ${domainName}`);
    }
    return validatorManagerConfig;
  }
}
