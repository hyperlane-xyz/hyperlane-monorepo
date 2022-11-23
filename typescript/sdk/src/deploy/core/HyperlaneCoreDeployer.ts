import debug from 'debug';
import { ethers } from 'ethers';

import { Mailbox, MultisigIsm, Ownable } from '@hyperlane-xyz/core';
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
import { DeployOptions, HyperlaneDeployer } from '../HyperlaneDeployer';

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
    defaultIsmAddress: types.Address,
    ubcAddress: types.Address,
    deployOpts?: DeployOptions,
  ): Promise<ProxiedContract<Mailbox, BeaconProxyAddresses>> {
    const domain = chainMetadata[chain].id;
    const mailbox = await this.deployProxiedContract(
      chain,
      'mailbox',
      [domain],
      ubcAddress,
      [defaultIsmAddress],
      deployOpts,
    );
    return mailbox;
  }

  async deployMultisigIsm<LocalChain extends Chain>(
    chain: LocalChain,
  ): Promise<MultisigIsm> {
    const multisigIsm = await this.deployContract(chain, 'multisigIsm', []);
    const configChains = Object.keys(this.configMap) as Chain[];
    const remotes = this.multiProvider
      .intersect(configChains, false)
      .multiProvider.remoteChains(chain);
    await super.runIfOwner(chain, multisigIsm, async () => {
      // TODO: Remove extraneous validators
      for (const remote of remotes) {
        const multisigIsmConfig = this.configMap[remote].multisigIsm;
        const domain = ChainNameToDomainId[remote];
        let lastTx;
        for (const validator of multisigIsmConfig.validators) {
          const isValidator = await multisigIsm.isEnrolled(domain, validator);
          if (!isValidator) {
            this.logger(
              `Enrolling ${validator} as ${remote} validator on ${chain}`,
            );
            lastTx = await multisigIsm.enrollValidator(domain, validator);
          }
        }
        if (lastTx) {
          await this.multiProvider.getChainConnection(chain).handleTx(lastTx);
        }
        const threshold = await multisigIsm.threshold(domain);
        if (!threshold.eq(multisigIsmConfig.threshold)) {
          this.logger(
            `Setting ${remote} threshold to ${multisigIsmConfig.threshold} on ${chain}`,
          );
          const tx = multisigIsm.setThreshold(
            domain,
            multisigIsmConfig.threshold,
          );
          await this.multiProvider.getChainConnection(chain).handleTx(tx);
        }
      }
    });

    return multisigIsm;
  }

  async deployContracts<LocalChain extends Chain>(
    chain: LocalChain,
    config: CoreConfig,
    deployOpts?: DeployOptions,
  ): Promise<CoreContracts> {
    if (config.remove) {
      // skip deploying to chains configured to be removed
      return undefined as any;
    }

    const dc = this.multiProvider.getChainConnection(chain);
    const provider = dc.provider!;
    const startingBlockNumber = await provider.getBlockNumber();
    this.startingBlockNumbers[chain] = startingBlockNumber;

    // The UpgradeBeaconController address is encoded into the bytecode of
    // UpgradeBeacons, the address of which is encoded into the bytecode of
    // UpgradeBeaconProxies. So to have consistent addresses for upgradable
    // contracts, we need the UpgradeBeaconController to have a consistent
    // address.
    const upgradeBeaconController = await this.deployContract(
      chain,
      'upgradeBeaconController',
      [],
      deployOpts,
    );

    const interchainGasPaymaster = await this.deployProxiedContract(
      chain,
      'interchainGasPaymaster',
      [],
      upgradeBeaconController.address,
      [],
    );

    const multisigIsm = await this.deployMultisigIsm(chain);

    // In order to create2 multiple UpgradeBeacons for the same environment
    // we need to namespace the create2 salt used to create them.
    let mailboxDeployOpts = deployOpts;
    if (mailboxDeployOpts && mailboxDeployOpts.create2Salt) {
      mailboxDeployOpts.create2Salt = ethers.utils.solidityKeccak256(
        ['bytes32', 'string'],
        [mailboxDeployOpts.create2Salt, 'mailbox'],
      );
    }
    const mailbox = await this.deployMailbox(
      chain,
      multisigIsm.address,
      upgradeBeaconController.address,
      mailboxDeployOpts,
    );

    return {
      upgradeBeaconController,
      interchainGasPaymaster,
      mailbox,
      multisigIsm,
    };
  }

  static async transferOwnership<CoreChains extends ChainName>(
    core: HyperlaneCore<CoreChains>,
    owners: ChainMap<CoreChains, types.Address>,
    multiProvider: MultiProvider<CoreChains>,
  ): Promise<ChainMap<CoreChains, ethers.ContractReceipt[]>> {
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
      coreContracts.multisigIsm,
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
