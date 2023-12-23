import debug from 'debug';

import {
  InterchainGasPaymaster,
  ProxyAdmin,
  StorageGasOracle,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { IgpFactories, igpFactories } from './contracts';
import { DomainGasConfig, IgpConfig } from './types';

export class HyperlaneIgpDeployer extends HyperlaneDeployer<
  IgpConfig,
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

    const gasParamsToSet: InterchainGasPaymaster.GasParamStruct[] = [];
    const remotes = Object.keys(config.oracleConfig);
    for (const remote of remotes) {
      const remoteId = this.multiProvider.getDomainId(remote);
      const newGasOverhead = config.oracleConfig[remote].overhead;

      const currentGasConfig = await igp.destinationGasConfigs(remoteId);
      if (
        !eqAddress(currentGasConfig.gasOracle, storageGasOracle.address) ||
        !currentGasConfig.gasOverhead.eq(newGasOverhead)
      ) {
        this.logger(`Setting gas params for ${remote} to ${newGasOverhead}`);
        gasParamsToSet.push({
          remoteDomain: remoteId,
          config: {
            gasOverhead: newGasOverhead,
            gasOracle: storageGasOracle.address,
          },
        });
      }
    }

    if (gasParamsToSet.length > 0) {
      await this.runIfOwner(chain, igp, async () =>
        this.multiProvider.handleTx(
          chain,
          igp.setDestinationGasConfigs(
            gasParamsToSet,
            this.multiProvider.getTransactionOverrides(chain),
          ),
        ),
      );
    }
    return igp;
  }

  async deployStorageGasOracle(chain: ChainName): Promise<StorageGasOracle> {
    return this.deployContract(chain, 'storageGasOracle', []);
  }

  async configureStorageGasOracle(
    chain: ChainName,
    igp: InterchainGasPaymaster,
    gasOracleConfig: ChainMap<DomainGasConfig>,
  ): Promise<void> {
    const remotes = Object.keys(gasOracleConfig);
    const configsToSet: Record<
      Address,
      StorageGasOracle.RemoteGasDataConfigStruct[]
    > = {};
    for (const remote of remotes) {
      const gasOracleAddress = (await igp.destinationGasConfigs(remote))
        .gasOracle;
      const gasOracle = StorageGasOracle__factory.connect(
        gasOracleAddress,
        this.multiProvider.getProvider(chain),
      );
      const remoteGasDataConfig = await gasOracle.remoteGasData(remote);
      const desiredGasData = gasOracleConfig[remote];

      if (
        !remoteGasDataConfig.gasPrice.eq(desiredGasData.gasPrice) ||
        !remoteGasDataConfig.tokenExchangeRate.eq(
          desiredGasData.tokenExchangeRate,
        )
      ) {
        configsToSet[gasOracleAddress].push({
          remoteDomain: this.multiProvider.getDomainId(remote),
          ...desiredGasData,
        });
      }
    }

    const gasOracles = Object.keys(configsToSet);
    for (const gasOracle of gasOracles) {
      const gasOracleContract = StorageGasOracle__factory.connect(
        gasOracle,
        this.multiProvider.getProvider(chain),
      );
      if (configsToSet[gasOracle].length > 0) {
        this.logger(
          `Setting gas oracle on ${gasOracle} for ${configsToSet[gasOracle].map(
            (config) => config.remoteDomain,
          )}`,
        );
        await this.runIfOwner(chain, gasOracleContract, async () =>
          this.multiProvider.handleTx(
            chain,
            gasOracleContract.setRemoteGasDataConfigs(
              configsToSet[gasOracle],
              this.multiProvider.getTransactionOverrides(chain),
            ),
          ),
        );
      }
    }
  }

  async deployContracts(
    chain: ChainName,
    config: IgpConfig,
  ): Promise<HyperlaneContracts<IgpFactories>> {
    // NB: To share ProxyAdmins with HyperlaneCore, ensure the ProxyAdmin
    // is loaded into the contract cache.
    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);

    const storageGasOracle = await this.deployStorageGasOracle(chain);
    const interchainGasPaymaster = await this.deployInterchainGasPaymaster(
      chain,
      proxyAdmin,
      storageGasOracle,
      config,
    );
    await this.transferOwnershipOfContracts(chain, config.owner, {
      interchainGasPaymaster,
    });

    // Configure oracle key for StorageGasOracle separately to keep 'hot'
    // for updating exchange rates regularly
    await this.transferOwnershipOfContracts(chain, config.oracleKey, {
      storageGasOracle,
    });

    return {
      proxyAdmin,
      storageGasOracle,
      interchainGasPaymaster,
    };
  }
}
