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
  ChainConnection,
  ChainMap,
  ChainName,
  CoreContractAddresses,
  CoreContracts,
  InboxContracts,
  MailboxAddresses,
  MultiProvider,
  RemoteChainMap,
  Remotes,
  chainMetadata,
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
  Chain extends ChainName,
> extends AbacusAppDeployer<
  Chain,
  CoreConfig,
  CoreContractAddresses<Chain, any>
> {
  inboxFactoryBuilder: FactoryBuilder = (signer: ethers.Signer) =>
    new Inbox__factory(signer);
  outboxFactoryBuilder: FactoryBuilder = (signer: ethers.Signer) =>
    new Outbox__factory(signer);

  startingBlockNumbers: ChainMap<Chain, number | undefined>;

  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, CoreConfig>,
  ) {
    super(multiProvider, configMap);
    this.startingBlockNumbers = objMap(configMap, () => undefined);
  }

  async deployContracts<LocalChain extends Chain>(
    chain: LocalChain,
    config: CoreConfig,
  ): Promise<CoreContractAddresses<Chain, LocalChain>> {
    const dc = this.multiProvider.getChainConnection(chain);
    const signer = dc.signer!;

    const provider = dc.provider!;
    const startingBlockNumber = await provider.getBlockNumber();
    this.startingBlockNumbers[chain] = startingBlockNumber;

    const upgradeBeaconController = await this.deployContract(
      chain,
      'UpgradeBeaconController',
      new UpgradeBeaconController__factory(signer),
      [],
    );

    const outboxValidatorManagerConfig = config.validatorManager;
    const domain = chainMetadata[chain].id;
    const outboxValidatorManager = await this.deployContract(
      chain,
      'OutboxValidatorManager',
      new OutboxValidatorManager__factory(signer),
      [
        domain,
        outboxValidatorManagerConfig.validators,
        outboxValidatorManagerConfig.threshold,
      ],
    );

    const outbox = await this.deployProxiedContract(
      chain,
      'Outbox',
      this.outboxFactoryBuilder(signer),
      [domain],
      upgradeBeaconController.address,
      [outboxValidatorManager.address],
    );

    const interchainGasPaymaster = await this.deployContract(
      chain,
      'InterchainGasPaymaster',
      new InterchainGasPaymaster__factory(signer),
      [],
    );

    const abacusConnectionManager = await this.deployContract(
      chain,
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
      (k) => k !== chain,
    ) as Remotes<Chain, LocalChain>[];

    const deployValidatorManager = async (
      remote: Remotes<Chain, LocalChain>,
    ): Promise<InboxValidatorManager> => {
      const remoteConfig = this.configMap[remote].validatorManager;
      return this.deployContract(
        chain,
        'InboxValidatorManager',
        new InboxValidatorManager__factory(signer),
        [
          chainMetadata[remote].id,
          remoteConfig.validators,
          remoteConfig.threshold,
        ],
      );
    };

    const [firstRemote, ...trailingRemotes] = remotes;
    const firstValidatorManager = await deployValidatorManager(firstRemote);
    const firstInbox = await this.deployProxiedContract(
      chain,
      'Inbox',
      this.inboxFactoryBuilder(signer),
      [domain],
      upgradeBeaconController.address,
      [
        chainMetadata[firstRemote].id,
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

    type RemoteMailboxEntry = [Remotes<Chain, LocalChain>, MailboxAddresses];

    const firstInboxAddresses: RemoteMailboxEntry = [
      firstRemote,
      getMailbox(firstValidatorManager, firstInbox),
    ];

    const trailingInboxAddresses = await Promise.all(
      trailingRemotes.map(async (remote): Promise<RemoteMailboxEntry> => {
        const validatorManager = await deployValidatorManager(remote);
        const inbox = await this.duplicateProxiedContract(
          chain,
          'Inbox',
          firstInbox,
          [
            chainMetadata[remote].id,
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
        abacusConnectionManager.enrollInbox(
          chainMetadata[remote].id,
          mailbox.proxy,
        ),
      ),
    );

    return {
      upgradeBeaconController: upgradeBeaconController.address,
      abacusConnectionManager: abacusConnectionManager.address,
      interchainGasPaymaster: interchainGasPaymaster.address,
      outbox: getMailbox(outboxValidatorManager, outbox),
      inboxes: Object.fromEntries(inboxAddresses) as RemoteChainMap<
        Chain,
        LocalChain,
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
      objMap(core.contractsMap, async (chain, coreContracts) => {
        const owner = owners[chain];
        const chainConnection = multiProvider.getChainConnection(chain);
        return AbacusCoreDeployer.transferOwnershipOfChain(
          coreContracts,
          owner,
          chainConnection,
        );
      }),
    );
  }

  static async transferOwnershipOfChain<
    Chain extends ChainName,
    Local extends Chain,
  >(
    core: CoreContracts<Chain, Local>,
    owner: types.Address,
    chainConnection: ChainConnection,
  ): Promise<ethers.ContractReceipt> {
    await core.contracts.outbox.validatorManager.transferOwnership(
      owner,
      chainConnection.overrides,
    );
    await core.contracts.abacusConnectionManager.transferOwnership(
      owner,
      chainConnection.overrides,
    );
    await core.contracts.upgradeBeaconController.transferOwnership(
      owner,
      chainConnection.overrides,
    );
    const inboxContracts: InboxContracts[] = Object.values(
      core.contracts.inboxes,
    );
    await Promise.all(
      inboxContracts.map(async (inbox) => {
        await inbox.validatorManager.transferOwnership(
          owner,
          chainConnection.overrides,
        );
        await inbox.inbox.transferOwnership(owner, chainConnection.overrides);
      }),
    );

    const tx = await core.contracts.outbox.outbox.transferOwnership(
      owner,
      chainConnection.overrides,
    );
    return tx.wait(chainConnection.confirmations);
  }
}
