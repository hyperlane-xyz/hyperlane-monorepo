import { ethers } from 'ethers';

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
import {
  AbacusCore,
  ChainMap,
  ChainName,
  CoreContractAddresses,
  CoreContracts,
  DomainConnection,
  InboxContracts,
  MailboxAddresses,
  MultiProvider,
  RemoteChainMap,
  Remotes,
  domains,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { AbacusAppDeployer } from '../deploy';
import { ProxiedContract } from '../proxy';

export type ValidatorManagerConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig = {
  validatorManager: ValidatorManagerConfig;
};

type FactoryBuilder = (signer: ethers.Signer) => ethers.ContractFactory;

export class AbacusCoreDeployer<
  Networks extends ChainName,
> extends AbacusAppDeployer<
  Networks,
  CoreConfig,
  CoreContractAddresses<Networks, any>
> {
  inboxFactoryBuilder: FactoryBuilder = (signer: ethers.Signer) =>
    new Inbox__factory(signer);
  outboxFactoryBuilder: FactoryBuilder = (signer: ethers.Signer) =>
    new Outbox__factory(signer);

  startingBlockNumbers: ChainMap<Networks, number | undefined>;

  constructor(
    multiProvider: MultiProvider<Networks>,
    configMap: ChainMap<Networks, CoreConfig>,
  ) {
    super(multiProvider, configMap);
    this.startingBlockNumbers = objMap(configMap, () => undefined);
  }

  async deployContracts<Local extends Networks>(
    network: Local,
    config: CoreConfig,
  ): Promise<CoreContractAddresses<Networks, Local>> {
    const dc = this.multiProvider.getDomainConnection(network);
    const signer = dc.signer!;

    const provider = dc.provider!;
    const startingBlockNumber = await provider.getBlockNumber();
    this.startingBlockNumbers[network] = startingBlockNumber;

    const upgradeBeaconController = await this.deployContract(
      network,
      'UpgradeBeaconController',
      new UpgradeBeaconController__factory(signer),
      [],
    );

    const outboxValidatorManagerConfig = config.validatorManager;
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
      this.outboxFactoryBuilder(signer),
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

    const remotes = Object.keys(this.configMap).filter(
      (k) => k !== network,
    ) as Remotes<Networks, Local>[];

    const deployValidatorManager = async (
      remote: Remotes<Networks, Local>,
    ): Promise<InboxValidatorManager> => {
      const remoteConfig = this.configMap[remote].validatorManager;
      return this.deployContract(
        network,
        'InboxValidatorManager',
        new InboxValidatorManager__factory(signer),
        [domains[remote].id, remoteConfig.validators, remoteConfig.threshold],
      );
    };

    const [firstRemote, ...trailingRemotes] = remotes;
    const firstValidatorManager = await deployValidatorManager(firstRemote);
    const firstInbox = await this.deployProxiedContract(
      network,
      'Inbox',
      this.inboxFactoryBuilder(signer),
      [domain],
      upgradeBeaconController.address,
      [
        domains[firstRemote].id,
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

    const firstInboxAddresses: RemoteMailboxEntry = [
      firstRemote,
      getMailbox(firstValidatorManager, firstInbox),
    ];

    const trailingInboxAddresses = await Promise.all(
      trailingRemotes.map(async (remote): Promise<RemoteMailboxEntry> => {
        const validatorManager = await deployValidatorManager(remote);
        const inbox = await this.duplicateProxiedContract(
          network,
          'Inbox',
          firstInbox,
          [
            domains[remote].id,
            validatorManager.address,
            ethers.constants.HashZero,
            0,
          ],
        );

        return [remote, getMailbox(validatorManager, inbox)];
      }),
    );

    const inboxAddresses = [firstInboxAddresses, ...trailingInboxAddresses];

    await Promise.all(
      inboxAddresses.map(([remote, mailbox]) =>
        abacusConnectionManager.enrollInbox(domains[remote].id, mailbox.proxy),
      ),
    );

    return {
      upgradeBeaconController: upgradeBeaconController.address,
      abacusConnectionManager: abacusConnectionManager.address,
      interchainGasPaymaster: interchainGasPaymaster.address,
      outbox: getMailbox(outboxValidatorManager, outbox),
      inboxes: Object.fromEntries(inboxAddresses) as RemoteChainMap<
        Networks,
        Local,
        MailboxAddresses
      >,
    };
  }

  static async transferOwnership<CoreNetworks extends ChainName>(
    core: AbacusCore<CoreNetworks>,
    owners: ChainMap<CoreNetworks, types.Address>,
    multiProvider: MultiProvider<CoreNetworks>,
  ) {
    return promiseObjAll(
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
    const inboxContracts: InboxContracts[] = Object.values(
      core.contracts.inboxes,
    );
    await Promise.all(
      inboxContracts.map(async (inbox) => {
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
