import { ethers } from 'ethers';

import {
  InterchainGasPaymaster,
  ProxyAdmin,
  StorageGasOracle,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';
import {
  addBufferToGasLimit,
  assert,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { TOKEN_EXCHANGE_RATE_SCALE_ETHEREUM } from '../consts/igp.js';
import { HyperlaneContracts } from '../contracts/types.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { submitBatched } from '../deploy/utils.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { IgpVersion } from '../hook/types.js';
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

  protected assertLegacyIgpConfig(chain: ChainName, config: IgpConfig): void {
    if (config.igpVersion !== IgpVersion.Legacy) return;

    assert(
      !config.quoteSigners?.length,
      `Legacy IGP on ${chain} does not support quoteSigners`,
    );

    assert(
      !config.tokenOracleConfig ||
        Object.keys(config.tokenOracleConfig).length === 0,
      'Legacy IGP on ' + chain + ' does not support tokenOracleConfig',
    );

    const cachedAddresses = this.cachedAddresses[chain] ?? {};
    const requiredCachedContracts: Array<keyof IgpFactories> = [
      'interchainGasPaymaster',
      'proxyAdmin',
      'storageGasOracle',
    ];
    const missing = requiredCachedContracts.filter(
      (contractName) => !cachedAddresses[contractName],
    );

    assert(
      missing.length === 0,
      `Legacy IGP on ${chain} requires existing cached addresses for ${missing.join(
        ', ',
      )}`,
    );
  }

  async deployInterchainGasPaymaster(
    chain: ChainName,
    proxyAdmin: ProxyAdmin,
    storageGasOracle: StorageGasOracle,
    config: IgpConfig,
  ): Promise<InterchainGasPaymaster> {
    this.assertLegacyIgpConfig(chain, config);

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
        await submitBatched(
          chain,
          gasParamsToSet,
          async (batch) => {
            const estimatedGas =
              await igp.estimateGas.setDestinationGasConfigs(batch);
            await this.multiProvider.handleTx(
              chain,
              igp.setDestinationGasConfigs(batch, {
                gasLimit: addBufferToGasLimit(estimatedGas),
                ...this.multiProvider.getTransactionOverrides(chain),
              }),
            );
          },
          this.logger,
          'gas configs',
        );
      });
    }

    if (config.quoteSigners?.length) {
      for (const signer of config.quoteSigners) {
        this.logger.debug(`Adding quote signer ${signer} to IGP on ${chain}`);
        await this.multiProvider.handleTx(
          chain,
          igp.addQuoteSigner(
            signer,
            this.multiProvider.getTransactionOverrides(chain),
          ),
        );
      }
    }

    await this.configureTokenGasOracles(chain, igp, config);

    return igp;
  }

  async deployStorageGasOracle(
    chain: ChainName,
    config: IgpConfig,
  ): Promise<StorageGasOracle> {
    this.assertLegacyIgpConfig(chain, config);

    const gasOracle = await this.deployContract(chain, 'storageGasOracle', []);

    if (!config.oracleConfig) {
      this.logger.debug('No oracle config provided, skipping...');
      return gasOracle;
    }

    await this.configureStorageGasOracle(
      chain,
      gasOracle,
      config.oracleConfig,
      config.overhead,
    );

    return gasOracle;
  }

  /**
   * Reconciles the remote gas data stored on a StorageGasOracle against the
   * desired config, submitting only the drifted entries. Shared by the native
   * oracle and per-fee-token oracles.
   */
  protected async configureStorageGasOracle(
    chain: ChainName,
    gasOracle: StorageGasOracle,
    oracleConfig: NonNullable<IgpConfig['oracleConfig']>,
    overhead: IgpConfig['overhead'],
  ): Promise<void> {
    this.logger.info(`Configuring gas oracle from ${chain}...`);
    const configsToSet: Array<StorageGasOracle.RemoteGasDataConfigStruct> = [];

    // For each remote, check if the gas oracle has the correct data
    for (const [remote, desired] of Object.entries(oracleConfig)) {
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

      const exampleRemoteGas = (overhead[remote] ?? 200_000) + 50_000;
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
        await submitBatched(
          chain,
          configsToSet,
          async (batch) => {
            const estimatedGas =
              await gasOracle.estimateGas.setRemoteGasDataConfigs(batch);
            await this.multiProvider.handleTx(
              chain,
              gasOracle.setRemoteGasDataConfigs(batch, {
                gasLimit: addBufferToGasLimit(estimatedGas),
                ...this.multiProvider.getTransactionOverrides(chain),
              }),
            );
          },
          this.logger,
          'gas oracle configs',
        );
      });
    }
  }

  /**
   * Wires per-fee-token gas oracles on the IGP for ERC20-denominated gas
   * payments. Target-driven and idempotent: each fee token's oracle is resolved
   * from the on-chain tokenGasOracles mapping (no off-chain bookkeeping), or a
   * dedicated StorageGasOracle is deployed if none is wired yet. Must run while
   * the deployer still owns the IGP (setTokenGasOracles is onlyOwner) and after
   * the native gas params, since the IGP requires a destination's native oracle
   * to exist before a token oracle can be set for it.
   */
  protected async configureTokenGasOracles(
    chain: ChainName,
    igp: InterchainGasPaymaster,
    config: IgpConfig,
  ): Promise<void> {
    if (!config.tokenOracleConfig) return;
    this.assertLegacyIgpConfig(chain, config);

    for (const [feeToken, oracleConfig] of Object.entries(
      config.tokenOracleConfig,
    )) {
      const remotes = Object.keys(oracleConfig)
        .map((remote) => ({
          remote,
          remoteDomain: this.multiProvider.tryGetDomainId(remote),
        }))
        .filter(
          (r): r is { remote: string; remoteDomain: number } =>
            r.remoteDomain !== null,
        );

      if (remotes.length === 0) {
        this.logger.warn(
          `Skipping token gas oracle for ${feeToken} on ${chain}: no configured remotes in MultiProvider`,
        );
        continue;
      }

      // Reuse the oracle already wired for this fee token (across any of its
      // destinations), otherwise deploy a dedicated one.
      let gasOracle: StorageGasOracle | undefined;
      for (const { remoteDomain } of remotes) {
        const existing = await igp.tokenGasOracles(feeToken, remoteDomain);
        if (!eqAddress(existing, ethers.constants.AddressZero)) {
          gasOracle = StorageGasOracle__factory.connect(
            existing,
            this.multiProvider.getSigner(chain),
          );
          break;
        }
      }

      if (!gasOracle) {
        // shouldRecover=false so we don't read back the native 'storageGasOracle'
        // cache entry; idempotency comes from the on-chain mapping check above.
        gasOracle = await this.deployContractFromFactory(
          chain,
          new StorageGasOracle__factory(),
          'storageGasOracle',
          [],
          undefined,
          false,
        );
      }

      await this.configureStorageGasOracle(
        chain,
        gasOracle,
        oracleConfig,
        config.overhead,
      );

      // Transfer the token oracle to the configured oracle key, matching the
      // native oracle's ownership.
      assert(
        gasOracle,
        `Expected token gas oracle for ${feeToken} on ${chain}`,
      );
      await this.runIfOwner(chain, gasOracle, async () => {
        if (!eqAddress(await gasOracle.owner(), config.oracleKey)) {
          await this.multiProvider.handleTx(
            chain,
            gasOracle.transferOwnership(
              config.oracleKey,
              this.multiProvider.getTransactionOverrides(chain),
            ),
          );
        }
      });

      // Point any destinations not yet mapped to this oracle at it.
      const tokenOracleParams: InterchainGasPaymaster.TokenGasOracleConfigStruct[] =
        [];
      for (const { remoteDomain } of remotes) {
        const current = await igp.tokenGasOracles(feeToken, remoteDomain);
        if (!eqAddress(current, gasOracle.address)) {
          tokenOracleParams.push({
            feeToken,
            remoteDomain,
            gasOracle: gasOracle.address,
          });
        }
      }

      if (tokenOracleParams.length > 0) {
        await this.runIfOwner(chain, igp, async () => {
          this.logger.info(
            `Setting token gas oracles for ${feeToken} on ${chain} (domains ${tokenOracleParams
              .map((p) => p.remoteDomain)
              .join(', ')})`,
          );
          const estimatedGas =
            await igp.estimateGas.setTokenGasOracles(tokenOracleParams);
          await this.multiProvider.handleTx(
            chain,
            igp.setTokenGasOracles(tokenOracleParams, {
              gasLimit: addBufferToGasLimit(estimatedGas),
              ...this.multiProvider.getTransactionOverrides(chain),
            }),
          );
        });
      }
    }
  }

  async deployContracts(
    chain: ChainName,
    config: IgpConfig,
  ): Promise<HyperlaneContracts<IgpFactories>> {
    this.assertLegacyIgpConfig(chain, config);

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
