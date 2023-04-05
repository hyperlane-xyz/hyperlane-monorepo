import debug from 'debug';

import {
  InterchainGasPaymaster,
  OverheadIgp,
  Ownable,
  ProxyAdmin,
  StorageGasOracle,
} from '@hyperlane-xyz/core';
import { types, utils } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';
import { objMap } from '../utils/objects';

import { IgpFactories, igpFactories } from './contracts';
import { OverheadIgpConfig } from './types';

export class HyperlaneIgpDeployer extends HyperlaneDeployer<
  OverheadIgpConfig,
  IgpFactories
> {
  startingBlockNumbers: ChainMap<number | undefined>;

  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<OverheadIgpConfig>,
    factoriesOverride = igpFactories,
  ) {
    super(multiProvider, configMap, factoriesOverride, {
      logger: debug('hyperlane:IgpDeployer'),
    });
    this.startingBlockNumbers = objMap(configMap, () => undefined);
  }

  async deployInterchainGasPaymaster(
    chain: ChainName,
    proxyAdmin: ProxyAdmin,
    storageGasOracle: StorageGasOracle,
  ): Promise<InterchainGasPaymaster> {
    const beneficiary = this.configMap[chain].beneficiary;
    const owner = await this.multiProvider.getSignerAddress(chain);
    const igp = await this.deployProxiedContract(
      chain,
      'interchainGasPaymaster',
      proxyAdmin.address,
      [],
      [owner, beneficiary],
    );

    // Set the gas oracles
    const configChains = Object.keys(this.configMap);
    const remotes = this.multiProvider
      .intersect(configChains, false)
      .multiProvider.getRemoteChains(chain);

    const gasOracleConfigsToSet: InterchainGasPaymaster.GasOracleConfigStruct[] =
      [];

    for (const remote of remotes) {
      const remoteId = this.multiProvider.getDomainId(remote);
      const currentGasOracle = await igp.gasOracles(remoteId);
      if (!utils.eqAddress(currentGasOracle, storageGasOracle.address)) {
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

  async deployOverheadInterchainGasPaymaster(
    chain: ChainName,
    interchainGasPaymasterAddress: types.Address,
  ): Promise<OverheadIgp> {
    const overheadInterchainGasPaymaster = await this.deployContract(
      chain,
      'defaultIsmInterchainGasPaymaster',
      [interchainGasPaymasterAddress],
    );

    const configChains = Object.keys(this.configMap);
    const remotes = this.multiProvider
      .intersect(configChains, false)
      .multiProvider.getRemoteChains(chain);

    // Only set gas overhead configs if they differ from what's on chain
    const configs: OverheadIgp.DomainConfigStruct[] = [];
    for (const remote of remotes) {
      const remoteDomain = this.multiProvider.getDomainId(remote);
      const gasOverhead = this.configMap[chain].overhead[remote];
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
    const provider = this.multiProvider.getProvider(chain);
    const startingBlockNumber = await provider.getBlockNumber();
    this.startingBlockNumbers[chain] = startingBlockNumber;
    // NB: To share ProxyAdmins with HyperlaneCore, ensure the ProxyAdmin
    // is loaded into the contract cache.
    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);
    const storageGasOracle = await this.deployStorageGasOracle(chain);
    const interchainGasPaymaster = await this.deployInterchainGasPaymaster(
      chain,
      proxyAdmin,
      storageGasOracle,
    );
    const overheadInterchainGasPaymaster =
      await this.deployOverheadInterchainGasPaymaster(
        chain,
        interchainGasPaymaster.address,
      );
    // Ownership of the Mailbox and the interchainGasPaymaster is transferred upon initialization.
    const ownables: Ownable[] = [overheadInterchainGasPaymaster];
    await this.transferOwnershipOfContracts(chain, config.owner, ownables);

    return {
      proxyAdmin,
      storageGasOracle,
      interchainGasPaymaster,
      defaultIsmInterchainGasPaymaster: overheadInterchainGasPaymaster,
    };
  }
}
