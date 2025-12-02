import {
  AmountRoutingHook,
  CCIPHook,
  CCIPHook__factory,
  DomainRoutingHook,
  FallbackDomainRoutingHook,
  IL1CrossDomainMessenger__factory,
  OPStackHook,
  OPStackIsm,
  ProtocolFee,
  StaticAggregationHook__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  ZERO_ADDRESS_HEX_32,
  addBufferToGasLimit,
  addressToBytes32,
  deepEquals,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { CoreAddresses } from '../core/contracts.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { HyperlaneIgpDeployer } from '../gas/HyperlaneIgpDeployer.js';
import { IgpFactories } from '../gas/contracts.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { IsmType, OpStackIsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';

import { DeployedHook, HookFactories, hookFactories } from './contracts.js';
import {
  AggregationHookConfig,
  AmountRoutingHookConfig,
  CCIPHookConfig,
  DomainRoutingHookConfig,
  FallbackRoutingHookConfig,
  HookConfig,
  HookType,
  IgpHookConfig,
  OpStackHookConfig,
  ProtocolFeeHookConfig,
} from './types.js';

export class HyperlaneHookDeployer extends HyperlaneDeployer<
  HookConfig,
  HookFactories
> {
  constructor(
    multiProvider: MultiProvider,
    readonly core: ChainMap<Partial<CoreAddresses>>,
    readonly ismFactory: HyperlaneIsmFactory,
    contractVerifier?: ContractVerifier,
    concurrentDeploy = false,
    readonly igpDeployer = new HyperlaneIgpDeployer(
      multiProvider,
      contractVerifier,
      concurrentDeploy,
    ),
  ) {
    super(multiProvider, hookFactories, {
      logger: rootLogger.child({ module: 'HookDeployer' }),
      contractVerifier,
      concurrentDeploy,
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
    if (typeof config === 'string') {
      throw new Error('Hook deployer should not receive address config');
    }

    let hook: DeployedHook;
    if (
      config.type === HookType.MERKLE_TREE ||
      config.type === HookType.MAILBOX_DEFAULT
    ) {
      const mailbox = coreAddresses.mailbox;
      if (!mailbox) {
        throw new Error(`Mailbox address is required for ${config.type}`);
      }
      hook = await this.deployContract(chain, config.type, [mailbox]);
    } else if (config.type === HookType.INTERCHAIN_GAS_PAYMASTER) {
      const { interchainGasPaymaster } = await this.deployIgp(
        chain,
        config,
        coreAddresses,
      );
      hook = interchainGasPaymaster;
    } else if (config.type === HookType.AGGREGATION) {
      hook = (await this.deployAggregation(chain, config, coreAddresses))
        .aggregationHook; // deploy from factory
    } else if (config.type === HookType.PROTOCOL_FEE) {
      hook = await this.deployProtocolFee(chain, config);
    } else if (config.type === HookType.OP_STACK) {
      hook = await this.deployOpStack(chain, config, coreAddresses);
    } else if (
      config.type === HookType.ROUTING ||
      config.type === HookType.FALLBACK_ROUTING
    ) {
      hook = await this.deployRouting(chain, config, coreAddresses);
    } else if (config.type === HookType.PAUSABLE) {
      hook = await this.deployContract(chain, config.type, []);
      await this.transferOwnershipOfContracts(chain, config, {
        [HookType.PAUSABLE]: hook,
      });
    } else if (config.type === HookType.AMOUNT_ROUTING) {
      hook = await this.deployAmountRoutingHook(chain, config);
    } else if (config.type === HookType.CCIP) {
      hook = await this.deployCCIPHook(chain, config);
    } else {
      throw new Error(`Unsupported hook config: ${config}`);
    }

    const deployedContracts = { [config.type]: hook } as any; // partial
    this.addDeployedContracts(chain, deployedContracts);
    return deployedContracts;
  }

  async deployCCIPHook(
    chain: ChainName,
    config: CCIPHookConfig,
  ): Promise<CCIPHook> {
    const hook = this.ismFactory.ccipContractCache.getHook(
      chain,
      config.destinationChain,
    );
    if (!hook) {
      this.logger.error(
        `CCIP Hook not found for ${chain} -> ${config.destinationChain}`,
      );
      throw new Error(
        `CCIP Hook not found for ${chain} -> ${config.destinationChain}`,
      );
    }
    return CCIPHook__factory.connect(hook, this.multiProvider.getSigner(chain));
  }

  async deployProtocolFee(
    chain: ChainName,
    config: ProtocolFeeHookConfig,
  ): Promise<ProtocolFee> {
    this.logger.debug('Deploying ProtocolFeeHook for %s', chain);
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
    this.logger.debug('Deploying IGP as hook for %s', chain);
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
    this.logger.debug('Deploying AggregationHook for %s', chain);
    const aggregatedHooks: string[] = [];
    let hooks: any = {};
    for (const hookConfig of config.hooks) {
      if (typeof hookConfig === 'string') {
        aggregatedHooks.push(hookConfig);
        continue;
      }

      const subhooks = await this.deployContracts(
        chain,
        hookConfig,
        coreAddresses,
      );
      aggregatedHooks.push(subhooks[hookConfig.type].address);
      hooks = { ...hooks, ...subhooks };
    }

    this.logger.debug(
      { aggregationHook: config.hooks },
      `Deploying aggregation hook of type ${config.hooks.map((h) =>
        typeof h === 'string' ? h : h.type,
      )}...`,
    );
    const address = await this.ismFactory.deployStaticAddressSet(
      chain,
      this.ismFactory.getContracts(chain).staticAggregationHookFactory,
      aggregatedHooks,
      this.logger,
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
    this.logger.debug(
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
    const opstackIsm = (await this.ismFactory.deploy({
      destination: config.destinationChain,
      config: ismConfig,
      origin: chain,
    })) as OPStackIsm;
    // deploy opstack hook
    const hook = await this.deployContract(chain, HookType.OP_STACK, [
      mailbox,
      this.multiProvider.getDomainId(config.destinationChain),
      addressToBytes32(opstackIsm.address),
      config.nativeBridge,
    ]);
    const overrides = this.multiProvider.getTransactionOverrides(chain);
    // set authorized hook on opstack ism
    const authorizedHook = await opstackIsm.authorizedHook();
    if (authorizedHook === addressToBytes32(hook.address)) {
      this.logger.debug(
        'Authorized hook already set on ism %s',
        opstackIsm.address,
      );
      return hook;
    } else if (authorizedHook !== ZERO_ADDRESS_HEX_32) {
      this.logger.debug(
        'Authorized hook mismatch on ism %s, expected %s, got %s',
        opstackIsm.address,
        addressToBytes32(hook.address),
        authorizedHook,
      );
      throw new Error('Authorized hook mismatch');
    }
    // check if mismatch and redeploy hook
    this.logger.debug(
      'Setting authorized hook %s on ism % on destination %s',
      hook.address,
      opstackIsm.address,
      config.destinationChain,
    );
    await this.multiProvider.handleTx(
      config.destinationChain,
      opstackIsm.setAuthorizedHook(addressToBytes32(hook.address), overrides),
    );

    return hook;
  }

  async deployRouting(
    chain: ChainName,
    config: DomainRoutingHookConfig | FallbackRoutingHookConfig,
    coreAddresses = this.core[chain],
  ): Promise<DomainRoutingHook> {
    const mailbox = coreAddresses?.mailbox;
    if (!mailbox) {
      throw new Error(`Mailbox address is required for ${config.type}`);
    }

    // we don't config owner as config.owner because there're post-deploy steps like
    // enrolling routing hooks which need ownership, and therefore we transferOwnership at the end
    const deployer = await this.multiProvider.getSigner(chain).getAddress();

    let routingHook: DomainRoutingHook | FallbackDomainRoutingHook;
    switch (config.type) {
      case HookType.ROUTING: {
        this.logger.debug('Deploying DomainRoutingHook for %s', chain);
        routingHook = await this.deployContract(chain, HookType.ROUTING, [
          mailbox,
          deployer,
        ]);
        break;
      }
      case HookType.FALLBACK_ROUTING: {
        this.logger.debug('Deploying FallbackDomainRoutingHook for %s', chain);
        let fallbackAddress: Address;
        if (typeof config.fallback === 'string') {
          fallbackAddress = config.fallback;
        } else {
          const fallbackHook = await this.deployContracts(
            chain,
            config.fallback,
            coreAddresses,
          );
          fallbackAddress = fallbackHook[config.fallback.type].address;
        }
        routingHook = await this.deployContract(
          chain,
          HookType.FALLBACK_ROUTING,
          [mailbox, deployer, fallbackAddress],
        );
        break;
      }
      default:
        throw new Error(`Unexpected hook type: ${config}`);
    }

    const routingConfigs: DomainRoutingHook.HookConfigStruct[] = [];
    let prevHookConfig: HookConfig | undefined;
    let prevHookAddress: Address | undefined;
    for (const [dest, hookConfig] of Object.entries(config.domains)) {
      this.logger.debug(`Deploying routing hook for ${dest}`);
      const destDomain = this.multiProvider.getDomainId(dest);

      if (deepEquals(prevHookConfig, hookConfig) && prevHookAddress) {
        this.logger.debug(`Reusing hook ${prevHookAddress} for ${dest}`);
        routingConfigs.push({
          destination: destDomain,
          hook: prevHookAddress,
        });
        continue;
      }

      if (typeof hookConfig === 'string') {
        routingConfigs.push({
          destination: destDomain,
          hook: hookConfig,
        });
        prevHookConfig = hookConfig;
        prevHookAddress = hookConfig;
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
        prevHookConfig = hookConfig;
        prevHookAddress = hook[hookConfig.type].address;
      }
    }

    const overrides = this.multiProvider.getTransactionOverrides(chain);
    await this.runIfOwner(chain, routingHook, async () => {
      this.logger.debug(
        {
          chain,
          routingHookAddress: routingHook.address,
          routingConfigs,
        },
        'Setting routing hooks',
      );
      const estimatedGas =
        await routingHook.estimateGas.setHooks(routingConfigs);
      return this.multiProvider.handleTx(
        chain,
        routingHook.setHooks(routingConfigs, {
          gasLimit: addBufferToGasLimit(estimatedGas),
          ...overrides,
        }),
      );
    });

    await this.transferOwnershipOfContracts(chain, config, {
      [config.type]: routingHook,
    });

    return routingHook;
  }

  protected async deployAmountRoutingHook(
    chain: ChainName,
    config: AmountRoutingHookConfig,
  ): Promise<AmountRoutingHook> {
    const hooks = [];
    for (const hookConfig of [config.lowerHook, config.upperHook]) {
      if (typeof hookConfig === 'string') {
        hooks.push(hookConfig);
        continue;
      }

      const contracts = await this.deployContracts(
        chain,
        hookConfig.type,
        this.core[chain],
      );
      hooks.push(contracts[hookConfig.type].address);
    }

    const [lowerHook, upperHook] = hooks;

    // deploy routing hook
    const routingHook = await this.deployContract(
      chain,
      HookType.AMOUNT_ROUTING,
      [lowerHook, upperHook, config.threshold],
    );

    return routingHook;
  }
}
