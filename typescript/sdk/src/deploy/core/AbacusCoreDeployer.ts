import debug from 'debug';
import { ethers } from 'ethers';

import { Mailbox, MultisigZone, Ownable } from '@abacus-network/core';
import type { types } from '@abacus-network/utils';

import { chainMetadata } from '../../consts/chainMetadata';
import { AbacusCore, CoreContractsMap } from '../../core/AbacusCore';
import { CoreContracts, coreFactories } from '../../core/contracts';
import { ChainConnection } from '../../providers/ChainConnection';
import { MultiProvider } from '../../providers/MultiProvider';
import { BeaconProxyAddresses, ProxiedContract } from '../../proxy';
import { ChainMap, ChainName } from '../../types';
import { objMap, promiseObjAll } from '../../utils/objects';
import { AbacusDeployer } from '../AbacusDeployer';

import { CoreConfig } from './types';

export class AbacusCoreDeployer<Chain extends ChainName> extends AbacusDeployer<
  Chain,
  CoreConfig,
  CoreContracts,
  typeof coreFactories
> {
  startingBlockNumbers: ChainMap<Chain, number | undefined>;

  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, CoreConfig>,
    factoriesOverride = coreFactories,
  ) {
    super(multiProvider, configMap, factoriesOverride, {
      logger: debug('abacus:CoreDeployer'),
    });
    this.startingBlockNumbers = objMap(configMap, () => undefined);
  }

  // override return type for inboxes shape derived from chain
  async deploy(
    partialDeployment?: Partial<CoreContractsMap<Chain>>,
  ): Promise<CoreContractsMap<Chain>> {
    return super.deploy(partialDeployment) as Promise<CoreContractsMap<Chain>>;
  }

  async deployMailbox<LocalChain extends Chain>(
    chain: LocalChain,
    zoneAddress: types.Address,
    ubcAddress: types.Address,
  ): Promise<ProxiedContract<Mailbox, BeaconProxyAddresses>> {
    const domain = chainMetadata[chain].id;

    const mailbox = await this.deployProxiedContract(
      chain,
      'mailbox',
      [domain],
      ubcAddress,
      [zoneAddress],
    );
    return mailbox;
  }

  async deployZone<LocalChain extends Chain>(
    chain: LocalChain,
    // config: MultisigZoneConfig
  ): Promise<MultisigZone> {
    // const domain = chainMetadata[chain].id;
    const zone = await this.deployContract(chain, 'multisigZone', []);
    /*
    await zone.setThreshold(domain, config.threshold);
    for (const validator of config.validators) {
      await zone.enroll
    }
    */
    return zone;
  }

  async deployContracts<LocalChain extends Chain>(
    chain: LocalChain,
    config: CoreConfig,
  ): Promise<CoreContracts> {
    if (config.remove) {
      // skip deploying to chains configured to be removed
      return undefined as any;
    }

    const dc = this.multiProvider.getChainConnection(chain);
    const provider = dc.provider!;
    const startingBlockNumber = await provider.getBlockNumber();
    this.startingBlockNumbers[chain] = startingBlockNumber;

    const upgradeBeaconController = await this.deployContract(
      chain,
      'upgradeBeaconController',
      [],
    );

    const interchainGasPaymaster = await this.deployProxiedContract(
      chain,
      'interchainGasPaymaster',
      [],
      upgradeBeaconController.address,
      [],
    );

    const defaultZone = await this.deployZone(chain);

    const mailbox = await this.deployMailbox(
      chain,
      defaultZone.address,
      upgradeBeaconController.address,
    );

    return {
      upgradeBeaconController,
      interchainGasPaymaster,
      mailbox,
      defaultZone,
    };
  }

  static async transferOwnership<CoreNetworks extends ChainName>(
    core: AbacusCore<CoreNetworks>,
    owners: ChainMap<CoreNetworks, types.Address>,
    multiProvider: MultiProvider<CoreNetworks>,
  ): Promise<ChainMap<CoreNetworks, ethers.ContractReceipt[]>> {
    return promiseObjAll(
      objMap(core.contractsMap, async (chain, coreContracts) =>
        AbacusCoreDeployer.transferOwnershipOfChain(
          coreContracts,
          owners[chain],
          multiProvider.getChainConnection(chain),
        ),
      ),
    );
  }

  static async transferOwnershipOfChain(
    coreContracts: CoreContracts,
    owner: types.Address,
    chainConnection: ChainConnection,
  ): Promise<ethers.ContractReceipt[]> {
    const ownables: Ownable[] = [
      // coreContracts.mailbox.contract,
      coreContracts.defaultZone,
      coreContracts.upgradeBeaconController,
    ];
    return Promise.all(
      ownables.map((ownable) =>
        chainConnection.handleTx(
          ownable.transferOwnership(owner, chainConnection.overrides),
        ),
      ),
    );
  }
}
