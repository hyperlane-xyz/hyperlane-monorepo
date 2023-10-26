import debug from 'debug';

import {
  StaticAggregationHook__factory,
  StaticProtocolFee,
} from '@hyperlane-xyz/core';

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
  ProtocolFeeHookConfig,
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

  cacheAddressesMap(addressesMap: ChainMap<CoreAddresses>): void {
    this.igpDeployer.cacheAddressesMap(addressesMap);
    super.cacheAddressesMap(addressesMap);
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
    } else if (config.type === HookType.PROTOCOL_FEE) {
      const hook = await this.deployProtocolFee(chain, config);
      return { [config.type]: hook } as any;
    }

    throw new Error(`Unexpected hook type: ${JSON.stringify(config)}`);
  }

  async deployProtocolFee(
    chain: ChainName,
    config: ProtocolFeeHookConfig,
  ): Promise<StaticProtocolFee> {
    return this.deployContract(chain, HookType.PROTOCOL_FEE, [
      config.maxProtocolFee,
      config.protocolFee,
      config.beneficiary,
      config.owner,
    ]);
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
    const igpContracts = await this.igpDeployer.deployContracts(chain, config);
    // bubbling up addresses and verification input artifacts
    this.addDeployedContracts(
      chain,
      igpContracts,
      this.igpDeployer.verificationInputs[chain],
    );
    return igpContracts;
  }

  async deployAggregation(
    chain: ChainName,
    config: AggregationHookConfig,
    coreAddresses = this.core[chain],
  ): Promise<HyperlaneContracts<HookFactories>> {
    const aggregatedHooks: string[] = [];
    let hooks: any = {};
    for (const hookConfig of config.hooks) {
      const subhooks = await this.deployContracts(
        chain,
        hookConfig,
        coreAddresses,
      );
      aggregatedHooks.push(subhooks[hookConfig.type].address);
      hooks = { ...hooks, ...subhooks };
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
