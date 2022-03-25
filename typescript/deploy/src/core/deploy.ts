import path from 'path';
import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import {
  AbacusCore,
  ChainName,
  CoreContractAddresses,
  ProxiedAddress,
} from '@abacus-network/sdk';
import {
  UpgradeBeaconController,
  XAppConnectionManager,
  ValidatorManager,
  Inbox,
  UpgradeBeaconController__factory,
  XAppConnectionManager__factory,
  ValidatorManager__factory,
  Outbox__factory,
  Inbox__factory,
} from '@abacus-network/core';
import { DeployEnvironment, RustConfig } from '../config';
import { AbacusAppDeployer, ProxiedContract } from '../deploy';
import { CoreConfig } from './types';

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

    const validatorManager: ValidatorManager = await this.deployContract(
      domain,
      'ValidatorManager',
      new ValidatorManager__factory(signer),
    );

    for (const name of this.domainNames) {
      const validator = config.validators[name];
      if (!validator) throw new Error(`No validator for ${name}`);
      await validatorManager.enrollValidator(
        this.resolveDomain(name),
        validator,
        overrides,
      );
    }

    const outbox = await this.deployProxiedContract(
      domain,
      'Outbox',
      new Outbox__factory(signer),
      upgradeBeaconController.address,
      [domain],
      [validatorManager.address],
    );

    const xAppConnectionManager: XAppConnectionManager =
      await this.deployContract(
        domain,
        'XAppConnectionManager',
        new XAppConnectionManager__factory(signer),
      );
    await xAppConnectionManager.setOutbox(outbox.address, overrides);

    const inboxes: Record<types.Domain, ProxiedContract<Inbox>> = {};
    const inboxAddresses: Partial<Record<ChainName, ProxiedAddress>> = {};
    const remotes = this.remoteDomainNumbers(domain);
    for (let i = 0; i < remotes.length; i++) {
      const remote = remotes[i];
      const initArgs = [
        remote,
        validatorManager.address,
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
      validatorManager: validatorManager.address,
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
        const inboxAddress = addresses.inboxes[remoteName];
        if (!inboxAddress) throw new Error(`No inbox for ${remoteName}`);
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

        rustConfig.signers[remoteName] = { key: '', type: 'hexKey' };
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
