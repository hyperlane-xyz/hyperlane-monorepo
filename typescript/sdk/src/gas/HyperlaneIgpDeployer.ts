import debug from 'debug';
import { ethers } from 'ethers';

import {
  InterchainGasPaymaster,
  OverheadIgp,
  Ownable,
  Ownable__factory,
  ProxyAdmin,
  StorageGasOracle,
} from '@hyperlane-xyz/core';
import { types, utils } from '@hyperlane-xyz/utils';

import { DeployOptions, HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ProxiedContract, TransparentProxyAddresses } from '../proxy';
import { ChainMap, ChainName } from '../types';
import { objMap } from '../utils/objects';

import { IgpContracts, igpFactories } from './contracts';
import { OverheadIgpConfig } from './types';

export class HyperlaneIgpDeployer extends HyperlaneDeployer<
  OverheadIgpConfig,
  IgpContracts,
  typeof igpFactories
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
    proxyAdmin: types.Address,
    storageGasOracle: StorageGasOracle,
    deployOpts?: DeployOptions,
  ): Promise<
    ProxiedContract<InterchainGasPaymaster, TransparentProxyAddresses>
  > {
    const owner = this.configMap[chain].owner;
    const beneficiary = this.configMap[chain].beneficiary;
    const igp = await this.deployProxiedContract(
      chain,
      'interchainGasPaymaster',
      [beneficiary],
      proxyAdmin,
      [owner, beneficiary],
      deployOpts,
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
      const currentGasOracle = await igp.contract.gasOracles(remoteId);
      if (!utils.eqAddress(currentGasOracle, storageGasOracle.address)) {
        gasOracleConfigsToSet.push({
          remoteDomain: remoteId,
          gasOracle: storageGasOracle.address,
        });
      }
    }

    if (gasOracleConfigsToSet.length > 0) {
      await this.runIfOwner(chain, igp.contract, async () =>
        this.multiProvider.handleTx(
          chain,
          igp.contract.setGasOracles(gasOracleConfigsToSet),
        ),
      );
    }

    return igp;
  }

  async deployOverheadInterchainGasPaymaster(
    chain: ChainName,
    interchainGasPaymasterAddress: types.Address,
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
      'overheadIgp',
      [interchainGasPaymasterAddress],
      {
        ...deployOpts,
        initCalldata,
      },
    );

    const configChains = Object.keys(this.configMap);
    const remotes = this.multiProvider
      .intersect(configChains, false)
      .multiProvider.getRemoteChains(chain);

    // Only set gas overhead configs if they differ from what's on chain
    const configs: OverheadIgp.DomainConfigStruct[] = [];
    for (const remote of remotes) {
      const gasOverhead = this.configMap[chain].overhead[remote];
      const existingOverhead =
        await overheadInterchainGasPaymaster.destinationGasOverhead(remote);
      if (!existingOverhead.eq(gasOverhead)) {
        configs.push({ domain: remote, gasOverhead });
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
  ): Promise<IgpContracts> {
    const provider = this.multiProvider.getProvider(chain);
    const startingBlockNumber = await provider.getBlockNumber();
    this.startingBlockNumbers[chain] = startingBlockNumber;
    const storageGasOracle = await this.deployStorageGasOracle(chain);
    const interchainGasPaymaster = await this.deployInterchainGasPaymaster(
      chain,
      this.configMap[chain].proxyAdmin,
      storageGasOracle,
    );
    const overheadInterchainGasPaymaster =
      await this.deployOverheadInterchainGasPaymaster(
        chain,
        interchainGasPaymaster.address,
      );
    // Ownership of the Mailbox and the interchainGasPaymaster is transferred upon initialization.
    const ownables: Ownable[] = [overheadInterchainGasPaymaster];
    await this.transferOwnershipOfContracts(chain, ownables);

    return {
      storageGasOracle,
      interchainGasPaymaster,
      defaultIsmInterchainGasPaymaster: overheadInterchainGasPaymaster,
    };
  }

  async transferOwnershipOfContracts(
    chain: ChainName,
    ownables: Ownable[],
  ): Promise<ethers.ContractReceipt[]> {
    const owner = this.configMap[chain].owner;
    const receipts: ethers.ContractReceipt[] = [];
    for (const ownable of ownables) {
      const currentOwner = await ownable.owner();
      if (currentOwner.toLowerCase() !== owner.toLowerCase()) {
        const receipt = await super.runIfOwner(chain, ownable, () =>
          this.multiProvider.handleTx(
            chain,
            ownable.transferOwnership(
              owner,
              this.multiProvider.getTransactionOverrides(chain),
            ),
          ),
        );
        if (receipt) receipts.push(receipt);
      }
    }

    return receipts.filter((x) => x !== undefined) as ethers.ContractReceipt[];
  }
}
