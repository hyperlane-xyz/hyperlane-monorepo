import debug from 'debug';

import {
  InterchainGasPaymaster,
  ProxyAdmin,
  StorageGasOracle,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { CoreConfig } from '../core/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HookConfig, HookType, IgpHookConfig } from '../hook/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { IgpFactories, igpFactories } from './contracts';
import {
  GasOracleContractType,
  StorageGasOracleConfig,
  StorageGasOraclesConfig,
} from './oracle/types';
import { prettyRemoteGasData } from './oracle/utils';
import { IgpConfig } from './types';

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
      const newGasOverhead = config.overhead[remote];

      const currentGasConfig = await igp.destinationGasConfigs(remoteId);
      if (
        !eqAddress(currentGasConfig.gasOracle, storageGasOracle.address) ||
        !currentGasConfig.gasOverhead.eq(newGasOverhead)
      ) {
        this.logger(
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

  async deployStorageGasOracle(chain: ChainName): Promise<StorageGasOracle> {
    return this.deployContract(chain, 'storageGasOracle', []);
  }

  async configureStorageGasOracle(
    chain: ChainName,
    igp: InterchainGasPaymaster,
    gasOracleConfig: ChainMap<StorageGasOracleConfig>,
  ): Promise<void> {
    this.logger(`Configuring gas oracles for ${chain}...`);
    const remotes = Object.keys(gasOracleConfig);
    const configsToSet: Record<
      Address,
      StorageGasOracle.RemoteGasDataConfigStruct[]
    > = {};

    for (const remote of remotes) {
      const desiredGasData = gasOracleConfig[remote];
      if (desiredGasData.type !== GasOracleContractType.StorageGasOracle) {
        continue;
      }
      const remoteId = this.multiProvider.getDomainId(remote);
      // each destination can have a different gas oracle
      const gasOracleAddress = (await igp.destinationGasConfigs(remoteId))
        .gasOracle;
      const gasOracle = StorageGasOracle__factory.connect(
        gasOracleAddress,
        this.multiProvider.getSigner(chain),
      );
      if (!configsToSet[gasOracleAddress]) {
        configsToSet[gasOracleAddress] = [];
      }
      const remoteGasDataConfig = await gasOracle.remoteGasData(remoteId);

      if (
        !remoteGasDataConfig.gasPrice.eq(desiredGasData.gasPrice) ||
        !remoteGasDataConfig.tokenExchangeRate.eq(
          desiredGasData.tokenExchangeRate,
        )
      ) {
        this.logger(
          `${chain} -> ${remote} existing gas data:\n`,
          prettyRemoteGasData(remoteGasDataConfig),
        );
        this.logger(
          `${chain} -> ${remote} desired gas data:\n`,
          prettyRemoteGasData(desiredGasData),
        );
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
        this.multiProvider.getSigner(chain),
      );
      if (configsToSet[gasOracle].length > 0) {
        await this.runIfOwner(chain, gasOracleContract, async () => {
          this.logger(
            `Setting gas oracle on ${gasOracle} for ${configsToSet[
              gasOracle
            ].map((config) => config.remoteDomain)}`,
          );
          return this.multiProvider.handleTx(
            chain,
            gasOracleContract.setRemoteGasDataConfigs(
              configsToSet[gasOracle],
              this.multiProvider.getTransactionOverrides(chain),
            ),
          );
        });
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
    await this.configureStorageGasOracle(
      chain,
      interchainGasPaymaster,
      config.oracleConfig,
    );
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

// recursively fetches storage gas oracle configs from core config
// eg. test1: core.defaultHook.igpConfig.test1.oracleConfig
export function getStorageGasOracleConfigs(
  coreConfig: ChainMap<CoreConfig>,
): ChainMap<StorageGasOraclesConfig> {
  const storageGasOracleConfigs: ChainMap<StorageGasOraclesConfig> = {};
  for (const chain of Object.keys(coreConfig)) {
    storageGasOracleConfigs[chain] = getStorageGasOracleConfig(
      coreConfig[chain],
    );
  }
  return storageGasOracleConfigs;
}

function getStorageGasOracleConfig(
  coreConfig: CoreConfig,
): StorageGasOraclesConfig {
  const defaultIgpConfigs = getNestedIgpConfigs(coreConfig.defaultHook);
  const requiredIgpConfigs = getNestedIgpConfigs(coreConfig.requiredHook);

  const totalIgpConfigs = defaultIgpConfigs.concat(requiredIgpConfigs);
  if (totalIgpConfigs.length === 0 || totalIgpConfigs.length > 1) {
    throw Error(
      `Incorrect number (${totalIgpConfigs.length}) of IGP configs found in core config. Please check your config.`,
    );
  } else if (totalIgpConfigs.length == 1 && requiredIgpConfigs.length > 0) {
    throw Error(
      'Both default and required IGP configs found in core config. Please check your config.',
    );
  }
  return totalIgpConfigs[0].oracleConfig;
}

// fetching igp configs from core config
// NB: returning a list of configs because of the possibility of nested configs
function getNestedIgpConfigs(hookConfig: HookConfig): IgpHookConfig[] {
  let igpConfigs: IgpHookConfig[] = [];

  if (hookConfig.type === HookType.INTERCHAIN_GAS_PAYMASTER) {
    igpConfigs.push(hookConfig as IgpHookConfig);
  } else if (hookConfig.type === HookType.AGGREGATION) {
    for (const hook of hookConfig.hooks) {
      igpConfigs = igpConfigs.concat(getNestedIgpConfigs(hook));
    }
  } else if (
    hookConfig.type === HookType.ROUTING ||
    hookConfig.type === HookType.FALLBACK_ROUTING
  ) {
    const domains = Object.values(hookConfig.domains); // Convert to array
    for (const domain of domains) {
      igpConfigs = igpConfigs.concat(getNestedIgpConfigs(domain));
    }
    igpConfigs =
      hookConfig.type === HookType.FALLBACK_ROUTING
        ? igpConfigs.concat(getNestedIgpConfigs(hookConfig.fallback))
        : igpConfigs;
  }

  return igpConfigs;
}
