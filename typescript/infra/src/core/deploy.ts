import {
  InboxValidatorManager,
  InboxValidatorManager__factory,
  Inbox__factory,
  InterchainGasPaymaster__factory,
  OutboxValidatorManager,
  OutboxValidatorManager__factory,
  Outbox__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
  XAppConnectionManager,
  XAppConnectionManager__factory,
} from '@abacus-network/core';
import { AbacusAppDeployer, ProxiedContract } from '@abacus-network/deploy';
import {
  AbacusCore,
  ChainName,
  CoreContractAddresses,
  Mailbox,
} from '@abacus-network/sdk';
import { Remotes } from '@abacus-network/sdk/dist/types';
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import path from 'path';
import { DeployEnvironment, RustConfig } from '../config';
import { CoreConfig } from './types';

export class AbacusCoreDeployer extends AbacusAppDeployer<
  CoreContractAddresses<ChainName, any>,
  CoreConfig<ChainName>
> {
  async deployContracts<Networks extends ChainName, Local extends Networks>(
    domain: number | Local,
    config: CoreConfig<Networks>,
  ): Promise<CoreContractAddresses<Networks, Local>> {
    const overrides = this.getOverrides(domain);
    const signer = this.mustGetSigner(domain);
    const upgradeBeaconController: UpgradeBeaconController =
      await this.deployContract(
        domain,
        'UpgradeBeaconController',
        new UpgradeBeaconController__factory(signer),
        [],
      );

    const domainName = this.mustResolveDomainName(domain) as Local;

    const outboxValidatorManagerConfig = config.validatorManagers[domainName];
    const outboxValidatorManager: OutboxValidatorManager =
      await this.deployContract(
        domain,
        'OutboxValidatorManager',
        new OutboxValidatorManager__factory(signer),
        [
          domain,
          outboxValidatorManagerConfig.validators,
          outboxValidatorManagerConfig.threshold,
        ],
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
      [],
    );

    const xAppConnectionManager: XAppConnectionManager =
      await this.deployContract(
        domain,
        'XAppConnectionManager',
        new XAppConnectionManager__factory(signer),
        [],
      );
    await xAppConnectionManager.setOutbox(outbox.address, overrides);
    await xAppConnectionManager.setInterchainGasPaymaster(
      interchainGasPaymaster.address,
      overrides,
    );

    const remotes = Object.keys(config.validatorManagers).filter(
      (k) => k !== domain,
    ) as Remotes<Networks, Local>[];

    const deployValidatorManager = async (
      remote: Remotes<Networks, Local>,
    ): Promise<InboxValidatorManager> => {
      const validatorManagerConfig = config.validatorManagers[remote];
      return this.deployContract(
        domain,
        'InboxValidatorManager',
        new InboxValidatorManager__factory(signer),
        [
          remote,
          validatorManagerConfig.validators,
          validatorManagerConfig.threshold,
        ],
      );
    };

    const getMailbox = (
      validatorManager: ethers.Contract,
      box: ProxiedContract<ethers.Contract>,
    ): Mailbox => ({
      ...box.addresses,
      validatorManager: validatorManager.address,
    });

    const [firstRemote, ...trailingRemotes] = remotes;
    const firstValidatorManager = await deployValidatorManager(firstRemote);
    const firstInbox = await this.deployProxiedContract(
      domain,
      'Inbox',
      new Inbox__factory(signer),
      upgradeBeaconController.address,
      [domain],
      [
        firstRemote,
        firstValidatorManager.address,
        ethers.constants.HashZero,
        0,
      ],
    );

    type RemoteMailboxEntry = [Remotes<Networks, Local>, Mailbox];

    const firstRemoteMailbox: RemoteMailboxEntry = [
      firstRemote,
      getMailbox(firstValidatorManager, firstInbox),
    ];

    const trailingRemoteMailboxes = await Promise.all(
      trailingRemotes.map(async (remote): Promise<RemoteMailboxEntry> => {
        const validatorManager = await deployValidatorManager(remote);
        const inbox = await this.duplicateProxiedContract(
          domain,
          'Inbox',
          firstInbox,
          [remote, validatorManager.address, ethers.constants.HashZero, 0],
        );

        return [remote, getMailbox(validatorManager, inbox)];
      }),
    );

    const remoteMailboxes = [firstRemoteMailbox, ...trailingRemoteMailboxes];

    await Promise.all(
      remoteMailboxes.map(([remote, mailbox]) =>
        xAppConnectionManager.enrollInbox(remote, mailbox.proxy),
      ),
    );

    return {
      upgradeBeaconController: upgradeBeaconController.address,
      xAppConnectionManager: xAppConnectionManager.address,
      interchainGasPaymaster: interchainGasPaymaster.address,
      outbox: getMailbox(outboxValidatorManager, outbox),
      inboxes: Object.fromEntries(remoteMailboxes) as any, // TODO: fix cast
    };
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
        // @ts-ignore TODO: fix types
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
    await contracts.outboxValidatorManager.transferOwnership(owner, overrides);
    await contracts.xAppConnectionManager.transferOwnership(owner, overrides);
    await contracts.upgradeBeaconController.transferOwnership(owner, overrides);
    for (const chain of Object.keys(contracts.addresses.inboxes)) {
      await contracts
        // @ts-ignore TODO: fix types
        .inboxValidatorManager(chain)
        .transferOwnership(owner, overrides);
      // @ts-ignore TODO: fix types
      await contracts.inbox(chain).transferOwnership(owner, overrides);
    }
    const tx = await contracts.outbox.transferOwnership(owner, overrides);
    return tx.wait(core.getConfirmations(domain));
  }
}
