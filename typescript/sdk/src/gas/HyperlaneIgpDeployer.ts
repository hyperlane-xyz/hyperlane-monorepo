import debug from 'debug';

import {
  InterchainGasPaymaster,
  OverheadIgp,
  Ownable,
  Ownable__factory,
  ProxyAdmin,
  StorageGasOracle,
} from '@hyperlane-xyz/core';
import { types, utils } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts';
import { DeployOptions, HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
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
    deployOpts?: DeployOptions,
  ): Promise<InterchainGasPaymaster> {
    const owner = config.owner;
    const beneficiary = config.beneficiary;
    const igp = await this.deployProxiedContract(
      chain,
      'interchainGasPaymaster',
      [beneficiary],
      [owner, beneficiary],
      proxyAdmin.address,
      deployOpts,
    );

    const gasOracleConfigsToSet: InterchainGasPaymaster.GasOracleConfigStruct[] =
      [];

    const remotes = Object.keys(config.gasOracleType);
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

  async deployOverheadIGP(
    chain: ChainName,
    interchainGasPaymasterAddress: types.Address,
    config: OverheadIgpConfig,
    deployOpts?: DeployOptions,
  ): Promise<OverheadIgp> {
    const deployer = await this.multiProvider.getSignerAddress(chain);
    // Transfer ownership to the deployer so the destination gas overheads can be set
    const initCalldata = Ownable__factory.createInterface().encodeFunctionData(
      'transferOwnership',
      [deployer],
    );
    const overheadInterchainGasPaymaster = await this.deployContract(
      chain,
      'defaultIsmInterchainGasPaymaster',
      [interchainGasPaymasterAddress],
      {
        ...deployOpts,
        initCalldata,
      },
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

  async deployStorageGasOracle(
    chain: ChainName,
    deployOpts?: DeployOptions,
  ): Promise<StorageGasOracle> {
    return this.deployContract(chain, 'storageGasOracle', [], deployOpts);
  }

  async deployContracts(
    chain: ChainName,
    config: OverheadIgpConfig,
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
    const overheadIgp = await this.deployOverheadIGP(
      chain,
      interchainGasPaymaster.address,
      config,
    );
    // Ownership of the Mailbox and the interchainGasPaymaster is transferred upon initialization.
    const ownables: Ownable[] = [overheadIgp];
    await this.transferOwnershipOfContracts(chain, config.owner, ownables);

    return {
      proxyAdmin,
      storageGasOracle,
      interchainGasPaymaster,
      defaultIsmInterchainGasPaymaster: overheadIgp,
    };
  }
}
