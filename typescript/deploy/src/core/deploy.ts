import { ethers } from 'ethers';

import { Inbox } from '@abacus-network/core';
import {
  AbacusCore,
  BeaconProxyAddresses,
  ChainConnection,
  ChainMap,
  ChainName,
  CoreContracts,
  CoreContractsMap,
  InboxContracts,
  MultiProvider,
  OutboxContracts,
  ProxiedContract,
  RemoteChainMap,
  Remotes,
  chainMetadata,
  coreFactories,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { AbacusDeployer } from '../deploy';

export type ValidatorManagerConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig = {
  validatorManager: ValidatorManagerConfig;
};

export class AbacusCoreDeployer<Chain extends ChainName> extends AbacusDeployer<
  Chain,
  CoreConfig,
  typeof coreFactories,
  CoreContracts<Chain, Chain>
> {
  startingBlockNumbers: ChainMap<Chain, number | undefined>;

  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, CoreConfig>,
    factoriesOverride = coreFactories,
  ) {
    super(multiProvider, configMap, factoriesOverride);
    this.startingBlockNumbers = objMap(configMap, () => undefined);
  }

  async deploy(): Promise<CoreContractsMap<Chain>> {
    return super.deploy() as Promise<CoreContractsMap<Chain>>;
  }

  async deployOutbox<LocalChain extends Chain>(
    chain: LocalChain,
    config: ValidatorManagerConfig,
    ubcAddress: types.Address,
  ): Promise<OutboxContracts> {
    const domain = chainMetadata[chain].id;
    const outboxValidatorManager = await this.deployContract(
      chain,
      'outboxValidatorManager',
      [domain, config.validators, config.threshold],
    );

    // Wait for the ValidatorManager to be deployed so that the Outbox
    // constructor is happy.
    const chainConnection = this.multiProvider.getChainConnection(chain);
    await outboxValidatorManager.deployTransaction.wait(
      chainConnection.confirmations,
    );
    const outbox = await this.deployProxiedContract(
      chain,
      'outbox',
      [domain],
      ubcAddress,
      [outboxValidatorManager.address],
    );
    return { outbox, outboxValidatorManager };
  }

  async deployInbox<Local extends Chain>(
    localChain: Local,
    remoteChain: Remotes<Chain, Local>,
    config: ValidatorManagerConfig,
    ubcAddress: types.Address,
    duplicate?: ProxiedContract<Inbox, BeaconProxyAddresses>,
  ): Promise<InboxContracts> {
    const localDomain = chainMetadata[localChain].id;
    const remoteDomain = chainMetadata[remoteChain].id;
    const inboxValidatorManager = await this.deployContract(
      localChain,
      'inboxValidatorManager',
      [remoteDomain, config.validators, config.threshold],
    );
    // Wait for the ValidatorManager to be deployed so that the Inbox
    // constructor is happy.
    const chainConnection = this.multiProvider.getChainConnection(localChain);
    await inboxValidatorManager.deployTransaction.wait(
      chainConnection.confirmations,
    );
    const initArgs: Parameters<Inbox['initialize']> = [
      remoteDomain,
      inboxValidatorManager.address,
    ];
    let inbox: ProxiedContract<Inbox, BeaconProxyAddresses>;
    if (duplicate) {
      inbox = await this.duplicateProxiedContract(
        localChain,
        duplicate,
        initArgs,
      );
    } else {
      inbox = await this.deployProxiedContract(
        localChain,
        'inbox',
        [localDomain],
        ubcAddress,
        initArgs,
      );
    }
    return { inbox, inboxValidatorManager };
  }

  async deployContracts<LocalChain extends Chain>(
    chain: LocalChain,
    config: CoreConfig,
  ): Promise<CoreContracts<Chain, LocalChain>> {
    const dc = this.multiProvider.getChainConnection(chain);
    const provider = dc.provider!;
    const startingBlockNumber = await provider.getBlockNumber();
    this.startingBlockNumbers[chain] = startingBlockNumber;

    const upgradeBeaconController = await this.deployContract(
      chain,
      'upgradeBeaconController',
      [],
    );

    const abacusConnectionManager = await this.deployContract(
      chain,
      'abacusConnectionManager',
      [],
    );

    const outbox = await this.deployOutbox(
      chain,
      config.validatorManager,
      upgradeBeaconController.address,
    );
    await abacusConnectionManager.setOutbox(outbox.outbox.address);

    const remotes = this.multiProvider.remoteChains(chain);
    const inboxes: Partial<Record<Chain, InboxContracts>> = {};
    let prev: Chain | undefined;
    for (const remote of remotes) {
      const inbox = await this.deployInbox(
        chain,
        remote,
        this.configMap[remote].validatorManager,
        upgradeBeaconController.address,
        inboxes[prev]?.inbox,
      );
      await abacusConnectionManager.enrollInbox(
        chainMetadata[remote].id,
        inbox.inbox.address,
      );
      inboxes[remote] = inbox;
      prev = remote;
    }

    return {
      upgradeBeaconController,
      abacusConnectionManager,
      inboxes: inboxes as RemoteChainMap<Chain, LocalChain, InboxContracts>,
      ...outbox,
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
    coreContracts: CoreContracts<Chain, Local>,
    owner: types.Address,
    chainConnection: ChainConnection,
  ): Promise<ethers.ContractReceipt> {
    await coreContracts.outboxValidatorManager.transferOwnership(
      owner,
      chainConnection.overrides,
    );
    await coreContracts.abacusConnectionManager.transferOwnership(
      owner,
      chainConnection.overrides,
    );
    await coreContracts.upgradeBeaconController.transferOwnership(
      owner,
      chainConnection.overrides,
    );
    const inboxContracts = Object.values<InboxContracts>(coreContracts.inboxes);
    await Promise.all(
      inboxContracts.map(async (inbox) => {
        await inbox.inboxValidatorManager.transferOwnership(
          owner,
          chainConnection.overrides,
        );
        await inbox.inbox.contract.transferOwnership(
          owner,
          chainConnection.overrides,
        );
      }),
    );

    const tx = await coreContracts.outbox.contract.transferOwnership(
      owner,
      chainConnection.overrides,
    );
    return tx.wait(chainConnection.confirmations);
  }
}
