import debug from 'debug';

import {
  MerkleTreeHook__factory,
  StaticAddressSetFactory,
  StaticAddressSetFactory__factory,
  StaticAggregationHook__factory,
} from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIgpDeployer } from '../gas/HyperlaneIgpDeployer';
import { IgpFactories } from '../gas/contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import {
  AggregationHookFactory,
  HookFactories,
  MerkleTreeHookFactory,
  hookFactories,
} from './contracts';
import {
  AggregationHookConfig,
  HookConfig,
  HookType,
  IgpHookConfig,
} from './types';

export class HyperlaneHookDeployer extends HyperlaneDeployer<
  HookConfig,
  HookFactories
> {
  constructor(
    multiProvider: MultiProvider,
    readonly mailboxes: ChainMap<Address>,
    readonly aggregationHookFactory?: ChainMap<Address>,
  ) {
    super(multiProvider, hookFactories, {
      logger: debug('hyperlane:HyperlaneHookDeployer'),
    });
  }

  async deployContracts(
    chain: ChainName,
    config: HookConfig,
  ): Promise<HyperlaneContracts<HookFactories>> {
    if (config.type === HookType.MERKLE_TREE_HOOK) {
      return this.deployMerkleTreeHook(chain, config);
    } else if (config.type === HookType.AGGREGATION) {
      return this.deployAggregationHook(chain, config);
    } else if (config.type === HookType.IGP) {
      return this.deployIgpHook(chain, config);
    } else {
      throw new Error(`Unsupported hook type: ${config}`);
    }
  }

  async deployMerkleTreeHook(
    chain: ChainName,
    _: HookConfig,
  ): Promise<HyperlaneContracts<MerkleTreeHookFactory>> {
    this.logger(`Deploying MerkleTreeHook to ${chain}`);
    const merkleTreeHook = await this.multiProvider.handleDeploy(
      chain,
      new MerkleTreeHook__factory(),
      [this.mailboxes[chain]],
    );
    return {
      merkleTreeHook: merkleTreeHook,
    };
  }

  async deployIgpHook(
    chain: ChainName,
    config: IgpHookConfig,
  ): Promise<HyperlaneContracts<IgpFactories>> {
    this.logger(`Deploying InterchainGasPaymaster to ${chain}`);
    const deployer = new HyperlaneIgpDeployer(this.multiProvider);
    return await deployer.deployContracts(chain, config);
  }

  async deployAggregationHook(
    chain: ChainName,
    config: AggregationHookConfig,
  ): Promise<HyperlaneContracts<AggregationHookFactory>> {
    const signer = this.multiProvider.getSigner(chain);
    this.logger(`Deploying AggregationHook to ${chain}`);
    const addresses: Address[] = [];
    for (const module of config.modules) {
      addresses.push(
        this.getDeployedAddress(await this.deployContracts(chain, module)),
      );
    }
    if (!this.aggregationHookFactory || !this.aggregationHookFactory[chain]) {
      throw new Error('No aggregation hook factory for chain');
    }
    const address = await this.deployAddressSetFactory(
      chain,
      StaticAddressSetFactory__factory.connect(
        this.aggregationHookFactory[chain],
        signer,
      ),
      addresses,
    );
    return {
      aggregationHook: StaticAggregationHook__factory.connect(
        address,
        this.multiProvider.getProvider(chain),
      ),
    };
  }

  private async deployAddressSetFactory(
    chain: ChainName,
    factory: StaticAddressSetFactory,
    values: Address[],
  ): Promise<Address> {
    const sorted = [...values].sort();
    const address = await factory['getAddress(address[])'](sorted);
    const provider = this.multiProvider.getProvider(chain);
    const code = await provider.getCode(address);
    if (code === '0x') {
      this.logger(`Deploying new ${values.length} address set to ${chain}`);
      const overrides = this.multiProvider.getTransactionOverrides(chain);
      const hash = await factory['deploy(address[])'](sorted, overrides);
      await this.multiProvider.handleTx(chain, hash);
    } else {
      this.logger(`Recovered ${values.length} address set on ${chain}`);
    }
    return address;
  }

  getDeployedAddress(
    deployedContracts: HyperlaneContracts<HookFactories>,
  ): Address {
    if (deployedContracts.merkleTreeHook)
      return deployedContracts.merkleTreeHook.address;
    else if (deployedContracts.aggregationHook)
      return deployedContracts.aggregationHook.address;
    else if (deployedContracts.interchainGasPaymaster)
      return deployedContracts.interchainGasPaymaster.address;
    else throw new Error('No hook deployed');
  }
}
