import debug from 'debug';
import { ethers } from 'ethers';

import { Mailbox, MultisigModule, Ownable } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../../consts/chainMetadata';
import { HyperlaneCore } from '../../core/HyperlaneCore';
import { CoreContracts, coreFactories } from '../../core/contracts';
import { ChainNameToDomainId } from '../../domains';
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

  async deployMailbox<LocalChain extends Chain>(
    chain: LocalChain,
    moduleAddress: types.Address,
    ubcAddress: types.Address,
  ): Promise<ProxiedContract<Mailbox, BeaconProxyAddresses>> {
    const domain = chainMetadata[chain].id;

    const mailbox = await this.deployProxiedContract(
      chain,
      'mailbox',
      [domain],
      ubcAddress,
      [moduleAddress],
    );
    return mailbox;
  }

  async deployMultisigModule<LocalChain extends Chain>(
    chain: LocalChain,
  ): Promise<MultisigModule> {
    const module = await this.deployContract(chain, 'multisigModule', []);
    const configChains = Object.keys(this.configMap) as Chain[];
    const remotes = this.multiProvider
      .intersect(configChains, false)
      .multiProvider.remoteChains(chain);
    await super.runIfOwner(chain, module, async () => {
      // TODO: Remove extraneous validators
      for (const remote of remotes) {
        const moduleConfig = this.configMap[remote].multisigModule;
        const domain = ChainNameToDomainId[remote];
        for (const validator of moduleConfig.validators) {
          const isValidator = await module.isEnrolled(domain, validator);
          if (!isValidator) {
            this.logger(
              `Enrolling ${validator} as ${remote} validator on ${chain}`,
            );
            await module.enrollValidator(domain, validator);
          }
        }
        const threshold = await module.threshold(domain);
        if (!threshold.eq(moduleConfig.threshold)) {
          this.logger(
            `Setting ${remote} threshold to ${moduleConfig.threshold} on ${chain}`,
          );
          await module.setThreshold(domain, moduleConfig.threshold);
        }
      }
    });

    return module;
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

    const multisigModule = await this.deployMultisigModule(chain);

    const mailbox = await this.deployMailbox(
      chain,
      multisigModule.address,
      upgradeBeaconController.address,
    );

    return {
      upgradeBeaconController,
      interchainGasPaymaster,
      mailbox,
      multisigModule,
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
      coreContracts.mailbox.contract,
      coreContracts.multisigModule,
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
