import debug from 'debug';
import { ethers } from 'ethers';

import {
  DomainRoutingHook,
  FallbackDomainRoutingHook,
  IL1CrossDomainMessenger__factory,
  OPStackHook,
  OPStackIsm,
  StaticAggregationHook__factory,
  StaticProtocolFee,
} from '@hyperlane-xyz/core';
import { Address, addressToBytes32 } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { CoreAddresses } from '../core/contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIgpDeployer } from '../gas/HyperlaneIgpDeployer';
import { IgpFactories } from '../gas/contracts';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { IsmType, OpStackIsmConfig } from '../ism/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { HookFactories, hookFactories } from './contracts';
import {
  AggregationHookConfig,
  HookConfig,
  HookType,
  IgpHookConfig,
  OpStackHookConfig,
  ProtocolFeeHookConfig,
  RoutingHookConfig,
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
    let hook;
    if (config.type === HookType.MERKLE_TREE) {
      const mailbox = coreAddresses.mailbox;
      if (!mailbox) {
        throw new Error(`Mailbox address is required for ${config.type}`);
      }
      hook = await this.deployContract(chain, config.type, [mailbox]);
      return { [config.type]: hook } as any;
    } else if (config.type === HookType.INTERCHAIN_GAS_PAYMASTER) {
      return this.deployIgp(chain, config, coreAddresses) as any;
    } else if (config.type === HookType.AGGREGATION) {
      return this.deployAggregation(chain, config, coreAddresses); // deploy from factory
    } else if (config.type === HookType.PROTOCOL_FEE) {
      hook = await this.deployProtocolFee(chain, config);
    } else if (config.type === HookType.OP_STACK) {
      hook = await this.deployOpStack(chain, config, coreAddresses);
    } else if (
      config.type === HookType.ROUTING ||
      config.type === HookType.FALLBACK_ROUTING
    ) {
      hook = await this.deployRouting(chain, config, coreAddresses);
    }
    const deployedContracts = { [config.type]: hook } as any;
    this.addDeployedContracts(chain, deployedContracts);
    return deployedContracts;
  }

  async deployProtocolFee(
    chain: ChainName,
    config: ProtocolFeeHookConfig,
  ): Promise<StaticProtocolFee> {
    this.logger('Deploying StaticProtocolFeeHook for %s', chain);
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
    this.logger('Deploying IGP as hook for %s', chain);
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
    this.logger('Deploying AggregationHook for %s', chain);
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
    this.addDeployedContracts(chain, hooks);
    return hooks;
  }

  async deployOpStack(
    chain: ChainName,
    config: OpStackHookConfig,
    coreAddresses = this.core[chain],
  ): Promise<OPStackHook> {
    this.logger(
      'Deploying OPStackHook for %s to %s',
      chain,
      config.destinationChain,
    );
    const mailbox = coreAddresses.mailbox;
    if (!mailbox) {
      throw new Error(`Mailbox address is required for ${config.type}`);
    }
    // fetch l2 messenger address from l1 messenger
    const l1Messenger = IL1CrossDomainMessenger__factory.connect(
      config.nativeBridge,
      this.multiProvider.getSignerOrProvider(chain),
    );
    const l2Messenger: Address = await l1Messenger.OTHER_MESSENGER();
    // deploy opstack ism
    const ismConfig: OpStackIsmConfig = {
      type: IsmType.OP_STACK,
      origin: chain,
      nativeBridge: l2Messenger,
    };
    const opstackIsm = await this.ismFactory.deploy(
      config.destinationChain,
      ismConfig,
      chain,
    );
    // deploy opstack hook
    const hook = await this.deployContract(chain, HookType.OP_STACK, [
      mailbox,
      this.multiProvider.getDomainId(config.destinationChain),
      addressToBytes32(opstackIsm.address),
      config.nativeBridge,
    ]);
    const overrides = this.multiProvider.getTransactionOverrides(chain);
    // set authorized hook on opstack ism
    const authorizedHook = await (opstackIsm as OPStackIsm).authorizedHook();
    if (authorizedHook === addressToBytes32(hook.address)) {
      this.logger('Authorized hook already set on ism %s', opstackIsm.address);
      return hook;
    } else if (
      authorizedHook !== addressToBytes32(ethers.constants.AddressZero)
    ) {
      this.logger(
        'Authorized hook mismatch on ism %s, expected %s, got %s',
        opstackIsm.address,
        addressToBytes32(hook.address),
        authorizedHook,
      );
      throw new Error('Authorized hook mismatch');
    }
    // check if mismatch and redeploy hook
    this.logger(
      'Setting authorized hook %s on ism % on destination %s',
      hook.address,
      opstackIsm.address,
      config.destinationChain,
    );
    await this.multiProvider.handleTx(
      config.destinationChain,
      (opstackIsm as OPStackIsm).setAuthorizedHook(
        addressToBytes32(hook.address),
        overrides,
      ),
    );

    return hook;
  }

  async deployRouting(
    chain: ChainName,
    config: RoutingHookConfig,
    coreAddresses = this.core[chain],
  ): Promise<DomainRoutingHook> {
    const mailbox = coreAddresses?.mailbox;
    if (!mailbox) {
      throw new Error(`Mailbox address is required for ${config.type}`);
    }

    let routingHook: DomainRoutingHook | FallbackDomainRoutingHook;
    switch (config.type) {
      case HookType.ROUTING: {
        this.logger('Deploying DomainRoutingHook for %s', chain);
        routingHook = await this.deployContract(chain, HookType.ROUTING, [
          mailbox,
          config.owner,
        ]);
        break;
      }
      case HookType.FALLBACK_ROUTING: {
        this.logger('Deploying FallbackDomainRoutingHook for %s', chain);
        const fallbackHook = await this.deployContracts(
          chain,
          config.fallback,
          coreAddresses,
        );
        routingHook = await this.deployContract(
          chain,
          HookType.FALLBACK_ROUTING,
          [mailbox, config.owner, fallbackHook[config.fallback.type].address],
        );
        break;
      }
      default:
        throw new Error(`Unexpected hook type: ${config}`);
    }

    const routingConfigs: DomainRoutingHook.HookConfigStruct[] = [];
    for (const [dest, hookConfig] of Object.entries(config.domains)) {
      const destDomain = this.multiProvider.getDomainId(dest);
      if (typeof hookConfig === 'string') {
        routingConfigs.push({
          destination: destDomain,
          hook: hookConfig,
        });
      } else {
        const hook = await this.deployContracts(
          chain,
          hookConfig,
          coreAddresses,
        );
        routingConfigs.push({
          destination: destDomain,
          hook: hook[hookConfig.type].address,
        });
      }
    }

    await this.multiProvider.handleTx(
      chain,
      routingHook.setHooks(routingConfigs),
    );

    return routingHook;
  }
}
