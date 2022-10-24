import { Mailbox, MultisigModule, Ownable } from '@abacus-network/core';
import type { types } from '@abacus-network/utils';
import debug from 'debug';
import { ethers } from 'ethers';

import { chainMetadata } from '../../consts/chainMetadata';
import { CoreContractsMap, HyperlaneCore } from '../../core/HyperlaneCore';
import { CoreContracts, coreFactories } from '../../core/contracts';
import { ChainConnection } from '../../providers/ChainConnection';
import { MultiProvider } from '../../providers/MultiProvider';
import { BeaconProxyAddresses, ProxiedContract } from '../../proxy';
import { ChainMap, ChainName } from '../../types';
import { objMap, promiseObjAll } from '../../utils/objects';
import { HyperlaneDeployer } from '../HyperlaneDeployer';

import { CoreConfig } from './types';

export class HyperlaneCoreDeployer<
  Chain extends ChainName,
> extends HyperlaneDeployer<
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
      logger: debug('hyperlane:CoreDeployer'),
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

  async deployModule<LocalChain extends Chain>(
    chain: LocalChain,
    // config: MultisigModuleConfig
  ): Promise<MultisigModule> {
    // const domain = chainMetadata[chain].id;
    const zone = await this.deployContract(chain, 'multisigModule', []);
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

    const defaultModule = await this.deployModule(chain);

    const mailbox = await this.deployMailbox(
      chain,
      defaultModule.address,
      upgradeBeaconController.address,
    );

    return {
      upgradeBeaconController,
      interchainGasPaymaster,
      mailbox,
      defaultModule,
    };
  }

  static async transferOwnership<CoreNetworks extends ChainName>(
    core: HyperlaneCore<CoreNetworks>,
    owners: ChainMap<CoreNetworks, types.Address>,
    multiProvider: MultiProvider<CoreNetworks>,
  ): Promise<ChainMap<CoreNetworks, ethers.ContractReceipt[]>> {
    return promiseObjAll(
      objMap(core.contractsMap, async (chain, coreContracts) =>
        HyperlaneCoreDeployer.transferOwnershipOfChain(
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
      coreContracts.defaultModule,
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
