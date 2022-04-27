import {
  AbacusConnectionManager__factory,
  InboxValidatorManager,
  InboxValidatorManager__factory,
  Inbox__factory,
  InterchainGasPaymaster__factory,
  OutboxValidatorManager__factory,
  Outbox__factory,
  UpgradeBeaconController__factory,
} from '@abacus-network/core';
import { AbacusAppDeployer, ProxiedContract } from '@abacus-network/deploy';
import {
  AbacusCore,
  ChainName,
  CoreContractAddresses,
  CoreContracts,
  domains,
  MailboxAddresses,
  MultiProvider,
} from '@abacus-network/sdk';
import { DomainConnection } from '@abacus-network/sdk/dist/provider';
import {
  ChainSubsetMap,
  RemoteChainSubsetMap,
  Remotes,
} from '@abacus-network/sdk/dist/types';
import { objMap, promiseObjAll } from '@abacus-network/sdk/dist/utils';
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import path from 'path';
import { DeployEnvironment, RustConfig } from '../config';
import { CoreConfig } from './types';

export class AbacusCoreDeployer<
  Networks extends ChainName,
> extends AbacusAppDeployer<
  Networks,
  CoreConfig<Networks>,
  CoreContractAddresses<Networks, any>
> {
  constructor(
    multiProvider: MultiProvider<Networks>,
    config: CoreConfig<Networks>,
  ) {
    const networks = Object.keys(config) as Networks[];
    const crossConfigMap = Object.fromEntries(
      networks.map((network) => [network, config]),
    ) as ChainSubsetMap<Networks, CoreConfig<Networks>>;
    super(multiProvider, crossConfigMap);
  }

  async deployContracts<Local extends Networks>(
    network: Local,
    config: CoreConfig<Networks>,
  ): Promise<CoreContractAddresses<Networks, Local>> {
    const dc = this.multiProvider.getDomainConnection(network);
    const signer = dc.signer!;
    const upgradeBeaconController = await this.deployContract(
      network,
      'UpgradeBeaconController',
      new UpgradeBeaconController__factory(signer),
      [],
    );

    const outboxValidatorManagerConfig = config.validatorManagers[network];
    const domain = domains[network].id;
    const outboxValidatorManager = await this.deployContract(
      network,
      'OutboxValidatorManager',
      new OutboxValidatorManager__factory(signer),
      [
        domain,
        outboxValidatorManagerConfig.validators,
        outboxValidatorManagerConfig.threshold,
      ],
    );

    const outbox = await this.deployProxiedContract(
      network,
      'Outbox',
      new Outbox__factory(signer),
      [domain],
      upgradeBeaconController.address,
      [outboxValidatorManager.address],
    );

    const interchainGasPaymaster = await this.deployContract(
      network,
      'InterchainGasPaymaster',
      new InterchainGasPaymaster__factory(signer),
      [],
    );

    const abacusConnectionManager = await this.deployContract(
      network,
      'AbacusConnectionManager',
      new AbacusConnectionManager__factory(signer),
      [],
    );
    await abacusConnectionManager.setOutbox(
      outbox.contract.address,
      dc.overrides,
    );
    await abacusConnectionManager.setInterchainGasPaymaster(
      interchainGasPaymaster.address,
      dc.overrides,
    );

    const remotes = Object.keys(config.validatorManagers).filter(
      (k) => k !== network,
    ) as Remotes<Networks, Local>[];

    const deployValidatorManager = async (
      remote: Remotes<Networks, Local>,
    ): Promise<InboxValidatorManager> => {
      const validatorManagerConfig = config.validatorManagers[remote];
      return this.deployContract(
        network,
        'InboxValidatorManager',
        new InboxValidatorManager__factory(signer),
        [
          remote,
          validatorManagerConfig.validators,
          validatorManagerConfig.threshold,
        ],
      );
    };

    const [firstRemote, ...trailingRemotes] = remotes;
    const firstValidatorManager = await deployValidatorManager(firstRemote);
    const firstInbox = await this.deployProxiedContract(
      network,
      'Inbox',
      new Inbox__factory(dc.signer!),
      [domain],
      upgradeBeaconController.address,
      [
        firstRemote,
        firstValidatorManager.address,
        ethers.constants.HashZero,
        0,
      ],
    );

    const getMailbox = (
      validatorManager: ethers.Contract,
      box: ProxiedContract<ethers.Contract>,
    ): MailboxAddresses => ({
      ...box.addresses,
      validatorManager: validatorManager.address,
    });

    type RemoteMailboxEntry = [Remotes<Networks, Local>, MailboxAddresses];

    const firstRemoteMailbox: RemoteMailboxEntry = [
      firstRemote,
      getMailbox(firstValidatorManager, firstInbox),
    ];

    const trailingRemoteMailboxes = await Promise.all(
      trailingRemotes.map(async (remote): Promise<RemoteMailboxEntry> => {
        const validatorManager = await deployValidatorManager(remote);
        const inbox = await this.duplicateProxiedContract(
          network,
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
        abacusConnectionManager.enrollInbox(domains[remote].id, mailbox.proxy),
      ),
    );

    return {
      upgradeBeaconController: upgradeBeaconController.address,
      abacusConnectionManager: abacusConnectionManager.address,
      interchainGasPaymaster: interchainGasPaymaster.address,
      outbox: getMailbox(outboxValidatorManager, outbox),
      inboxes: Object.fromEntries(remoteMailboxes) as RemoteChainSubsetMap<
        Networks,
        Local,
        MailboxAddresses
      >,
    };
  }

  writeRustConfigs(
    environment: DeployEnvironment,
    directory: string,
    networkAddresses: Awaited<
      ReturnType<AbacusCoreDeployer<Networks>['deploy']>
    >,
  ) {
    objMap(this.configMap, (network) => {
      const filepath = path.join(directory, `${network}_config.json`);
      const addresses = networkAddresses[network];

      const outbox = {
        addresses: {
          outbox: addresses.outbox.proxy,
        },
        domain: domains[network].id.toString(),
        name: network,
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

      this.multiProvider.remotes(network).forEach((remote) => {
        const inboxAddresses = addresses.inboxes[remote];

        const inbox = {
          domain: domains[remote].id.toString(),
          name: remote,
          rpcStyle: 'ethereum',
          connection: {
            type: 'http',
            url: '',
          },
          addresses: {
            inbox: inboxAddresses.proxy,
            validatorManager: inboxAddresses.validatorManager,
          },
        };

        rustConfig.inboxes[remote as Networks] = inbox;
      });
      AbacusAppDeployer.writeJson(filepath, rustConfig);
    });
  }

  static async transferOwnership<CoreNetworks extends ChainName>(
    core: AbacusCore<CoreNetworks>,
    owners: ChainSubsetMap<CoreNetworks, types.Address>,
    multiProvider: MultiProvider<CoreNetworks>,
  ) {
    return promiseObjAll<Record<any, any>>(
      objMap(core.contractsMap, async (network, coreContracts) => {
        const owner = owners[network];
        const domainConnection = multiProvider.getDomainConnection(network);
        return AbacusCoreDeployer.transferOwnershipOfDomain(
          coreContracts,
          owner,
          domainConnection,
        );
      }),
    );
  }

  static async transferOwnershipOfDomain<
    CoreNetworks extends ChainName,
    Local extends CoreNetworks,
  >(
    core: CoreContracts<CoreNetworks, Local>,
    owner: types.Address,
    domainConnection: DomainConnection,
  ): Promise<ethers.ContractReceipt> {
    await core.contracts.outbox.validatorManager.transferOwnership(
      owner,
      domainConnection.overrides,
    );
    await core.contracts.abacusConnectionManager.transferOwnership(
      owner,
      domainConnection.overrides,
    );
    await core.contracts.upgradeBeaconController.transferOwnership(
      owner,
      domainConnection.overrides,
    );
    await promiseObjAll<Record<any, any>>(
      objMap(core.contracts.inboxes, async (_, inbox) => {
        await inbox.validatorManager.transferOwnership(
          owner,
          domainConnection.overrides,
        );
        await inbox.inbox.transferOwnership(owner, domainConnection.overrides);
      }),
    );
    const tx = await core.contracts.outbox.outbox.transferOwnership(
      owner,
      domainConnection.overrides,
    );
    return tx.wait(domainConnection.confirmations);
  }
}
