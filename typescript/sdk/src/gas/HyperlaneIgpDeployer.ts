import {
  InterchainGasPaymaster,
  ProxyAdmin,
  StorageGasOracle,
} from '@hyperlane-xyz/core';
import { eqAddress, rootLogger } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../consts/chainMetadata.js';
import { HyperlaneContracts } from '../contracts/types.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import { IgpFactories, igpFactories } from './contracts.js';
import { serializeDifference } from './oracle/types.js';
import { IgpConfig } from './types.js';

export class HyperlaneIgpDeployer extends HyperlaneDeployer<
  IgpConfig,
  IgpFactories
> {
  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
  ) {
    super(multiProvider, igpFactories, {
      logger: rootLogger.child({ module: 'IgpDeployer' }),
      contractVerifier,
    });
  }

  async deployInterchainGasPaymaster(
    chain: ChainName,
    proxyAdmin: ProxyAdmin,
    storageGasOracle: StorageGasOracle,
    config: IgpConfig,
  ): Promise<InterchainGasPaymaster> {
    const igp = await this.deployProxiedContract(
      chain,
      'interchainGasPaymaster',
      'interchainGasPaymaster',
      proxyAdmin.address,
      [],
      [await this.multiProvider.getSignerAddress(chain), config.beneficiary],
    );
    return igp;

    const gasParamsToSet: InterchainGasPaymaster.GasParamStruct[] = [];
    for (const [remote, newGasOverhead] of Object.entries(config.overhead)) {
      const remoteId =
        chainMetadata[remote]?.domainId ??
        this.multiProvider.getDomainId(remote);

      const currentGasConfig = await igp.destinationGasConfigs(remoteId);
      if (
        !eqAddress(currentGasConfig.gasOracle, storageGasOracle.address) ||
        !currentGasConfig.gasOverhead.eq(newGasOverhead)
      ) {
        this.logger.debug(
          `Setting gas params for ${chain} -> ${remote}: gasOverhead = ${newGasOverhead} gasOracle = ${storageGasOracle.address}`,
        );
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

  async deployStorageGasOracle(
    chain: ChainName,
    config: IgpConfig,
  ): Promise<StorageGasOracle> {
    const gasOracle = await this.deployContract(chain, 'storageGasOracle', []);

    if (!config.oracleConfig) {
      this.logger.debug('No oracle config provided, skipping...');
      return gasOracle;
    }

    console.log(`Configuring gas oracle from ${chain}...`);
    const configsToSet: Array<StorageGasOracle.RemoteGasDataConfigStruct> = [];

    // For each remote, check if the gas oracle has the correct data
    for (const [remote, desired] of Object.entries(config.oracleConfig)) {
      // check core metadata for non EVMs and fallback to multiprovider for custom EVMs
      const remoteDomain =
        chainMetadata[remote]?.domainId ??
        this.multiProvider.getDomainId(remote);

      const actual = await gasOracle.remoteGasData(remoteDomain);

      if (
        !actual.gasPrice.eq(desired.gasPrice) ||
        !actual.tokenExchangeRate.eq(desired.tokenExchangeRate)
      ) {
        console.log(`-> ${remote} ${serializeDifference(actual, desired)}`);
        configsToSet.push({
          remoteDomain,
          ...desired,
        });
      }
    }

    if (configsToSet.length > 0) {
      await this.runIfOwner(chain, gasOracle, async () =>
        this.multiProvider.handleTx(
          chain,
          gasOracle.setRemoteGasDataConfigs(
            configsToSet,
            this.multiProvider.getTransactionOverrides(chain),
          ),
        ),
      );
    }

    return gasOracle;
  }

  async deployContracts(
    chain: ChainName,
    config: IgpConfig,
  ): Promise<HyperlaneContracts<IgpFactories>> {
    // NB: To share ProxyAdmins with HyperlaneCore, ensure the ProxyAdmin
    // is loaded into the contract cache.
    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);

    const storageGasOracle = await this.deployStorageGasOracle(chain, config);
    const interchainGasPaymaster = await this.deployInterchainGasPaymaster(
      chain,
      proxyAdmin,
      storageGasOracle,
      config,
    );

    const contracts = {
      proxyAdmin,
      storageGasOracle,
      interchainGasPaymaster,
    };

    const ownerConfig = {
      ...config,
      ownerOverrides: {
        ...config.ownerOverrides,
        storageGasOracle: config.oracleKey,
      },
    };

    await this.transferOwnershipOfContracts(chain, ownerConfig, contracts);

    return contracts;
  }
}
