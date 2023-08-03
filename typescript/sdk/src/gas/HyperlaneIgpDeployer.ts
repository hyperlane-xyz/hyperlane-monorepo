import debug from 'debug';
import { ethers } from 'ethers';

import {
  InterchainGasPaymaster,
  OverheadIgp,
  ProxyAdmin,
  StorageGasOracle,
  TimelockController,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

import { IgpFactories, igpFactories } from './contracts';
import { IgpConfig, OverheadIgpConfig } from './types';

export class HyperlaneIgpDeployer extends HyperlaneDeployer<
  OverheadIgpConfig,
  IgpFactories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, igpFactories, {
      logger: debug('hyperlane:IgpDeployer'),
    });
  }

  async deployInterchainGasPaymaster(
    chain: ChainName,
    proxyAdmin: ProxyAdmin,
    storageGasOracle: StorageGasOracle,
    config: IgpConfig,
  ): Promise<InterchainGasPaymaster> {
    const owner = config.owner;
    const beneficiary = config.beneficiary;
    const igp = await this.deployProxiedContract(
      chain,
      'interchainGasPaymaster',
      proxyAdmin.address,
      [],
      [owner, beneficiary],
    );

    const gasOracleConfigsToSet: InterchainGasPaymaster.GasOracleConfigStruct[] =
      [];

    const remotes = Object.keys(config.gasOracleType);
    for (const remote of remotes) {
      const remoteId = this.multiProvider.getDomainId(remote);
      const currentGasOracle = await igp.gasOracles(remoteId);
      if (!eqAddress(currentGasOracle, storageGasOracle.address)) {
        gasOracleConfigsToSet.push({
          remoteDomain: remoteId,
          gasOracle: storageGasOracle.address,
        });
      }
    }

    if (gasOracleConfigsToSet.length > 0) {
      await this.runIfOwner(chain, igp, async () =>
        this.multiProvider.handleTx(
          chain,
          igp.setGasOracles(gasOracleConfigsToSet),
        ),
      );
    }
    return igp;
  }

  async deployOverheadIgp(
    chain: ChainName,
    interchainGasPaymasterAddress: Address,
    config: OverheadIgpConfig,
  ): Promise<OverheadIgp> {
    const overheadInterchainGasPaymaster = await this.deployContract(
      chain,
      'defaultIsmInterchainGasPaymaster',
      [interchainGasPaymasterAddress],
    );

    // Only set gas overhead configs if they differ from what's on chain
    const configs: OverheadIgp.DomainConfigStruct[] = [];
    const remotes = Object.keys(config.overhead);
    for (const remote of remotes) {
      const remoteDomain = this.multiProvider.getDomainId(remote);
      const gasOverhead = config.overhead[remote];
      const existingOverhead =
        await overheadInterchainGasPaymaster.destinationGasOverhead(
          remoteDomain,
        );
      if (!existingOverhead.eq(gasOverhead)) {
        configs.push({ domain: remoteDomain, gasOverhead });
      }
    }

    if (configs.length > 0) {
      await this.runIfOwner(chain, overheadInterchainGasPaymaster, () =>
        this.multiProvider.handleTx(
          chain,
          overheadInterchainGasPaymaster.setDestinationGasOverheads(
            configs,
            this.multiProvider.getTransactionOverrides(chain),
          ),
        ),
      );
    }

    return overheadInterchainGasPaymaster;
  }

  async deployStorageGasOracle(chain: ChainName): Promise<StorageGasOracle> {
    return this.deployContract(chain, 'storageGasOracle', []);
  }

  async deployContracts(
    chain: ChainName,
    config: OverheadIgpConfig,
  ): Promise<HyperlaneContracts<IgpFactories>> {
    // NB: To share ProxyAdmins with HyperlaneCore, ensure the ProxyAdmin
    // is loaded into the contract cache.
    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);
    let timelockController: TimelockController;
    if (config.upgrade) {
      timelockController = await this.deployTimelock(
        chain,
        config.upgrade.timelock,
      );
      await this.transferOwnershipOfContracts(
        chain,
        timelockController.address,
        { proxyAdmin },
      );
    } else {
      // mock this for consistent serialization
      timelockController = TimelockController__factory.connect(
        ethers.constants.AddressZero,
        this.multiProvider.getProvider(chain),
      );
      await this.transferOwnershipOfContracts(chain, config.owner, {
        proxyAdmin,
      });
    }

    const storageGasOracle = await this.deployStorageGasOracle(chain);
    const interchainGasPaymaster = await this.deployInterchainGasPaymaster(
      chain,
      proxyAdmin,
      storageGasOracle,
      config,
    );
    const overheadIgp = await this.deployOverheadIgp(
      chain,
      interchainGasPaymaster.address,
      config,
    );
    await this.transferOwnershipOfContracts(chain, config.owner, {
      overheadIgp,
      interchainGasPaymaster,
    });

    // Configure oracle key for StorageGasOracle separately to keep 'hot'
    // for updating exchange rates regularly
    await this.transferOwnershipOfContracts(chain, config.oracleKey, {
      storageGasOracle,
    });

    return {
      proxyAdmin,
      timelockController,
      storageGasOracle,
      interchainGasPaymaster,
      defaultIsmInterchainGasPaymaster: overheadIgp,
    };
  }
}
