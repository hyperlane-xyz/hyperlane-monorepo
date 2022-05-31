import { ethers } from 'ethers';

import { Inbox } from '@abacus-network/core';
import {
  AbacusCore,
  ChainConnection,
  ChainMap,
  ChainName,
  CoreContracts,
  InboxContracts,
  MultiProvider,
  OutboxContracts,
  RemoteChainMap,
  chainMetadata,
  coreFactories,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { AbacusDeployer } from '../deploy';
import { ProxiedContract } from '../proxy';

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
  ) {
    super(multiProvider, configMap, coreFactories);
    this.startingBlockNumbers = objMap(configMap, () => undefined);
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

    const outbox = await this.deployProxiedContract(
      chain,
      'outbox',
      [domain],
      ubcAddress,
      [outboxValidatorManager.address],
    );
    return { outbox: outbox.contract, outboxValidatorManager };
  }

  async deployInbox<LocalChain extends Chain>(
    chain: LocalChain,
    config: ValidatorManagerConfig,
    ubcAddress: types.Address,
    duplicate?: ProxiedContract<Inbox>,
  ): Promise<InboxContracts & { proxy: ProxiedContract<Inbox> }> {
    const domain = chainMetadata[chain].id;
    const inboxValidatorManager = await this.deployContract(
      chain,
      'inboxValidatorManager',
      [domain, config.validators, config.threshold],
    );
    const initArgs: Parameters<Inbox['initialize']> = [
      domain,
      inboxValidatorManager.address,
      ethers.constants.HashZero,
      0,
    ];
    let inbox: ProxiedContract<Inbox>;
    if (duplicate) {
      inbox = await this.duplicateProxiedContract(chain, duplicate, initArgs);
    } else {
      inbox = await this.deployProxiedContract(
        chain,
        'inbox',
        [domain],
        ubcAddress,
        initArgs,
      );
    }
    return { inbox: inbox.contract, inboxValidatorManager, proxy: inbox };
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

    const interchainGasPaymaster = await this.deployContract(
      chain,
      'interchainGasPaymaster',
      [],
    );

    const abacusConnectionManager = await this.deployContract(
      chain,
      'abacusConnectionManager',
      [],
    );
    await abacusConnectionManager.setInterchainGasPaymaster(
      interchainGasPaymaster.address,
    );

    const outbox = await this.deployOutbox(
      chain,
      config.validatorManager,
      upgradeBeaconController.address,
    );
    await abacusConnectionManager.setOutbox(outbox.outbox.address);

    const remotes = this.multiProvider.remoteChains(chain);
    let proxy: ProxiedContract<Inbox> | undefined;
    const inboxes: Partial<Record<Chain, InboxContracts>> = {};
    for (const remote of remotes) {
      const inbox = await this.deployInbox(
        remote,
        this.configMap[remote].validatorManager,
        upgradeBeaconController.address,
        proxy,
      );
      await abacusConnectionManager.enrollInbox(
        chainMetadata[remote].id,
        inbox.inbox.address,
      );
      proxy = inbox.proxy;
      inboxes[remote] = inbox;
    }

    return {
      upgradeBeaconController,
      abacusConnectionManager,
      interchainGasPaymaster,
      outbox,
      inboxes: inboxes as RemoteChainMap<Chain, LocalChain, InboxContracts>,
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
    await coreContracts.outbox.outboxValidatorManager.transferOwnership(
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
        await inbox.inbox.transferOwnership(owner, chainConnection.overrides);
      }),
    );

    const tx = await coreContracts.outbox.outbox.transferOwnership(
      owner,
      chainConnection.overrides,
    );
    return tx.wait(chainConnection.confirmations);
  }
}
