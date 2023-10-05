import debug from 'debug';

import { StaticAggregationHook__factory } from '@hyperlane-xyz/core';
import { objMerge } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { CoreAddresses } from '../core/contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIgpDeployer } from '../gas/HyperlaneIgpDeployer';
import { IgpFactories } from '../gas/contracts';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { HookFactories, hookFactories } from './contracts';
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
    readonly core: ChainMap<Partial<CoreAddresses>>,
    readonly ismFactory: HyperlaneIsmFactory,
    readonly igpDeployer = new HyperlaneIgpDeployer(multiProvider),
  ) {
    super(multiProvider, hookFactories, {
      logger: debug('hyperlane:HookDeployer'),
    });
  }

  async deployContracts(
    chain: ChainName,
    config: HookConfig,
    coreAddresses = this.core[chain],
  ): Promise<HyperlaneContracts<HookFactories>> {
    // other simple hooks can go here
    if (config.type === HookType.MERKLE_TREE) {
      const mailbox = coreAddresses.mailbox;
      if (!mailbox) {
        throw new Error(`Mailbox address is required for ${config.type}`);
      }
      const hook = await this.deployContract(chain, config.type, [mailbox]);
      return { [config.type]: hook } as any;
    } else if (config.type === HookType.INTERCHAIN_GAS_PAYMASTER) {
      return this.deployIgp(chain, config, coreAddresses) as any;
    } else if (config.type === HookType.AGGREGATION) {
      return this.deployAggregation(chain, config, coreAddresses);
    }

    throw new Error(`Unexpected hook type: ${JSON.stringify(config)}`);
  }

  async deployIgp(
    chain: ChainName,
    config: IgpHookConfig,
    coreAddresses = this.core[chain],
  ): Promise<HyperlaneContracts<IgpFactories>> {
    if (coreAddresses.proxyAdmin) {
      this.igpDeployer.writeCache(
        chain,
        'proxyAdmin',
        coreAddresses.proxyAdmin,
      );
    }
    // TODO: share timelock controller with core ?
    // this.igpDeployer.writeCache(chain, 'timelockController', coreAddresses.timelockController);
    const igpContracts = await this.igpDeployer.deployContracts(chain, config);
    this.deployedContracts[chain] = objMerge(
      this.deployedContracts[chain],
      igpContracts,
    );
    return igpContracts;
  }

  async deployAggregation(
    chain: ChainName,
    config: AggregationHookConfig,
    coreAddresses = this.core[chain],
  ): Promise<HyperlaneContracts<HookFactories>> {
    let aggregatedHooks: string[] = [];
    let hooks: any = {};
    for (const hookConfig of config.hooks) {
      const subhooks = await this.deployContracts(
        chain,
        hookConfig,
        coreAddresses,
      );
      // TODO: handle nesting
      hooks = { ...hooks, ...subhooks };
      aggregatedHooks.push(hooks[hookConfig.type].address);
    }
    const address = await this.ismFactory.deployStaticAddressSet(
      chain,
      this.ismFactory.getContracts(chain).aggregationHookFactory,
      aggregatedHooks,
    );
    hooks[HookType.AGGREGATION] = StaticAggregationHook__factory.connect(
      address,
      this.multiProvider.getSignerOrProvider(chain),
    );
    return hooks;
  }
}
