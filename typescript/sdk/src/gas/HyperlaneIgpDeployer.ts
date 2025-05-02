import { ethers } from 'ethers';

import {
  InterchainGasPaymaster,
  ProxyAdmin,
  StorageGasOracle,
} from '@hyperlane-xyz/core';
import {
  addBufferToGasLimit,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { TOKEN_EXCHANGE_RATE_SCALE_ETHEREUM } from '../consts/igp.js';
import { HyperlaneContracts } from '../contracts/types.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import { IgpFactories, igpFactories } from './contracts.js';
import {
  oracleConfigToOracleData,
  serializeDifference,
} from './oracle/types.js';
import { IgpConfig } from './types.js';

export class HyperlaneIgpDeployer extends HyperlaneDeployer<
  IgpConfig,
  IgpFactories
> {
  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
    concurrentDeploy: boolean = false,
  ) {
    super(multiProvider, igpFactories, {
      logger: rootLogger.child({ module: 'IgpDeployer' }),
      contractVerifier,
      concurrentDeploy,
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

    const gasParamsToSet: InterchainGasPaymaster.GasParamStruct[] = [];
    for (const [remote, newGasOverhead] of Object.entries(config.overhead)) {
      // TODO: add back support for non-EVM remotes.
      // Previously would check core metadata for non EVMs and fallback to multiprovider for custom EVMs
      const remoteId = this.multiProvider.tryGetDomainId(remote);
      if (remoteId === null) {
        this.logger.warn(
          `Skipping overhead ${chain} -> ${remote}. Expected if the remote is a non-EVM chain.`,
        );
        continue;
      }

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
      await this.runIfOwner(chain, igp, async () => {
        const estimatedGas =
          await igp.estimateGas.setDestinationGasConfigs(gasParamsToSet);
        return this.multiProvider.handleTx(
          chain,
          igp.setDestinationGasConfigs(gasParamsToSet, {
            gasLimit: addBufferToGasLimit(estimatedGas),
            ...this.multiProvider.getTransactionOverrides(chain),
          }),
        );
      });
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

    this.logger.info(`Configuring gas oracle from ${chain}...`);
    const configsToSet: Array<StorageGasOracle.RemoteGasDataConfigStruct> = [];

    // For each remote, check if the gas oracle has the correct data
    for (const [remote, desired] of Object.entries(config.oracleConfig)) {
      // TODO: add back support for non-EVM remotes.
      // Previously would check core metadata for non EVMs and fallback to multiprovider for custom EVMs
      const remoteDomain = this.multiProvider.tryGetDomainId(remote);
      if (remoteDomain === null) {
        this.logger.warn(
          `Skipping gas oracle ${chain} -> ${remote}. Expected if the remote is a non-EVM chain.`,
        );
        continue;
      }

      const actual = await gasOracle.remoteGasData(remoteDomain);

      const desiredData = oracleConfigToOracleData(desired);

      if (
        !actual.gasPrice.eq(desired.gasPrice) ||
        !actual.tokenExchangeRate.eq(desired.tokenExchangeRate)
      ) {
        this.logger.info(
          `${chain} -> ${remote}: ${serializeDifference(
            this.multiProvider.getProtocol(chain),
            actual,
            desiredData,
          )}`,
        );
        configsToSet.push({
          remoteDomain,
          ...desiredData,
        });
      }

      const exampleRemoteGas = (config.overhead[remote] ?? 200_000) + 50_000;
      const exampleRemoteGasCost = desiredData.tokenExchangeRate
        .mul(desiredData.gasPrice)
        .mul(exampleRemoteGas)
        .div(TOKEN_EXCHANGE_RATE_SCALE_ETHEREUM);
      this.logger.info(
        `${chain} -> ${remote}: ${exampleRemoteGas} remote gas cost: ${ethers.utils.formatEther(
          exampleRemoteGasCost,
        )}`,
      );
    }

    if (configsToSet.length > 0) {
      await this.runIfOwner(chain, gasOracle, async () => {
        const estimatedGas =
          await gasOracle.estimateGas.setRemoteGasDataConfigs(configsToSet);
        return this.multiProvider.handleTx(
          chain,
          gasOracle.setRemoteGasDataConfigs(configsToSet, {
            gasLimit: addBufferToGasLimit(estimatedGas),
            ...this.multiProvider.getTransactionOverrides(chain),
          }),
        );
      });
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
