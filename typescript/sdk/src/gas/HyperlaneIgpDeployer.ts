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

import multisigIsmVerifyCosts from '../consts/multisigIsmVerifyCosts.json';
import { DeployOptions, HyperlaneDeployer } from '../deploy';
import { MultiProvider } from '../providers';
import { ProxiedContract, TransparentProxyAddresses } from '../proxy';
import { ChainMap, ChainName } from '../types';
import { objMap } from '../utils';

import { IgpContracts, igpFactories } from './contracts';
import { GasOracleContractType } from './types';

export class HyperlaneIgpDeployer extends HyperlaneDeployer<
  IgpConfig,
  IgpContracts,
  typeof igpFactories
> {
  gasOverhead: ChainMap<OverheadIgp.DomainConfigStruct>;

  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<IgpConfig>,
    factoriesOverride = igpFactories,
  ) {
    super(multiProvider, configMap, factoriesOverride, {
      logger: debug('hyperlane:IgpDeployer'),
    });
    this.gasOverhead = objMap(configMap, (chain, config) => {
      const { validators, threshold } = config.multisigIsm;
      const verifyCost =
        // @ts-ignore
        multisigIsmVerifyCosts[`${validators.length}`][`${threshold}`];
      if (!verifyCost)
        throw new Error(
          `Unknown verification cost for ${threshold} of ${validators.length}`,
        );
      return {
        domain: multiProvider.getDomainId(chain),
        gasOverhead: verifyCost,
      };
    });
  }

  async deployInterchainGasPaymaster(
    chain: ChainName,
    proxyAdmin: ProxyAdmin,
    storageGasOracle: StorageGasOracle,
    deployOpts?: DeployOptions,
  ): Promise<
    ProxiedContract<InterchainGasPaymaster, TransparentProxyAddresses>
  > {
    const beneficiary = this.configMap[chain].igp.beneficiary;
    const igp = await this.deployProxiedContract(
      chain,
      'interchainGasPaymaster',
      [beneficiary],
      proxyAdmin,
      [beneficiary],
      deployOpts,
    );

    // Set the gas oracles

    const remotes = this.multiProvider.getRemoteChains(chain);

    const gasOracleConfigsToSet: InterchainGasPaymaster.GasOracleConfigStruct[] =
      [];

    for (const remote of remotes) {
      const remoteId = this.multiProvider.getDomainId(remote);
      const currentGasOracle = await igp.contract.gasOracles(remoteId);
      const desiredGasOracle = this.getGasOracleAddress(
        chain,
        remote,
        storageGasOracle,
      );
      if (!utils.eqAddress(currentGasOracle, desiredGasOracle)) {
        gasOracleConfigsToSet.push({
          remoteDomain: remoteId,
          gasOracle: desiredGasOracle,
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

  async deployDefaultIsmInterchainGasPaymaster(
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
    const defaultIsmInterchainGasPaymaster = await this.deployContract(
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
      const gasOverhead = this.gasOverhead[remote];
      const existingOverhead =
        await defaultIsmInterchainGasPaymaster.destinationGasOverhead(
          gasOverhead.domain,
        );
      if (!existingOverhead.eq(gasOverhead.gasOverhead)) {
        configs.push(gasOverhead);
      }
    }

    if (configs.length > 0) {
      await this.runIfOwner(chain, defaultIsmInterchainGasPaymaster, () =>
        this.multiProvider.handleTx(
          chain,
          defaultIsmInterchainGasPaymaster.setDestinationGasOverheads(
            configs,
            this.multiProvider.getTransactionOverrides(chain),
          ),
        ),
      );
    }

    return defaultIsmInterchainGasPaymaster;
  }

  async deployStorageGasOracle(
    chain: ChainName,
    deployOpts?: DeployOptions,
  ): Promise<StorageGasOracle> {
    return this.deployContract(chain, 'storageGasOracle', [], deployOpts);
  }

  async deployContracts(
    chain: ChainName,
    config: IgpConfig,
  ): Promise<IgpContracts> {
    if (config.remove) {
      // skip deploying to chains configured to be removed
      return undefined as any;
    }

    const storageGasOracle = await this.deployStorageGasOracle(chain);
    const interchainGasPaymaster = await this.deployInterchainGasPaymaster(
      chain,
      proxyAdmin,
      storageGasOracle,
    );
    const defaultIsmInterchainGasPaymaster =
      await this.deployDefaultIsmInterchainGasPaymaster(
        chain,
        interchainGasPaymaster.address,
      );
    // Ownership of the interchainGasPaymaster is transferred upon initialization.
    const ownables: Ownable[] = [defaultIsmInterchainGasPaymaster];
    await this.transferOwnershipOfContracts(chain, ownables);

    return {
      storageGasOracle,
      interchainGasPaymaster,
      defaultIsmInterchainGasPaymaster,
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

  private getGasOracleAddress(
    local: ChainName,
    remote: ChainName,
    storageGasOracle: StorageGasOracle,
  ): types.Address {
    const localConfig = this.configMap[local];
    const gasOracleType = localConfig.igp.gasOracles[remote];
    if (!gasOracleType) {
      throw Error(
        `Expected gas oracle type for local ${local} and remote ${remote}`,
      );
    }
    switch (gasOracleType) {
      case GasOracleContractType.StorageGasOracle: {
        return storageGasOracle.address;
      }
      default: {
        throw Error(`Unsupported gas oracle type ${gasOracleType}`);
      }
    }
  }
}
