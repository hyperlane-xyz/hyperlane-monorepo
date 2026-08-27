import { ethers } from 'ethers';

import {
  AmountRoutingHook,
  CCIPHook,
  CCIPHook__factory,
  DomainRoutingHook,
  DomainRoutingHook__factory,
  FallbackDomainRoutingHook,
  FallbackDomainRoutingHook__factory,
  IL1CrossDomainMessenger__factory,
  IPostDispatchHook__factory,
  MailboxClient__factory,
  MerkleTreeHook__factory,
  OPStackHook,
  OPStackIsm,
  PausableHook__factory,
  ProtocolFee,
  StaticAggregationHook__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  ZERO_ADDRESS_HEX_32,
  addBufferToGasLimit,
  addressToBytes32,
  assert,
  deepEquals,
  eqAddress,
  isZeroishAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { CoreAddresses } from '../core/contracts.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { getTxConfigBatchSize, submitBatched } from '../deploy/utils.js';
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
  OnchainHookType,
  OpStackHookConfig,
  PausableHookConfig,
  ProtocolFeeHookConfig,
} from './types.js';

// Hook types that can be recovered without redeployment when the config carries
// an existing address. Mutable recovered hooks are reconciled in place, and
// recovered composites traverse only explicitly addressed children.
const RECOVERABLE_HOOK_TYPES: HookType[] = [
  HookType.MERKLE_TREE,
  HookType.AGGREGATION,
  HookType.PAUSABLE,
  HookType.ROUTING,
  HookType.FALLBACK_ROUTING,
];

const RECOVERABLE_ONCHAIN_HOOK_TYPES: Partial<
  Record<HookType, OnchainHookType>
> = {
  [HookType.MERKLE_TREE]: OnchainHookType.MERKLE_TREE,
  [HookType.AGGREGATION]: OnchainHookType.AGGREGATION,
  [HookType.PAUSABLE]: OnchainHookType.PAUSABLE,
  [HookType.ROUTING]: OnchainHookType.ROUTING,
  [HookType.FALLBACK_ROUTING]: OnchainHookType.FALLBACK_ROUTING,
};

function configuredHookAddress(config: HookConfig): Address | undefined {
  if (typeof config === 'string') return config;
  return 'address' in config && typeof config.address === 'string'
    ? config.address
    : undefined;
}

interface RecoveredRoutingHookState {
  routingHook: DomainRoutingHook | FallbackDomainRoutingHook;
  routingConfigs: DomainRoutingHook.HookConfigStruct[];
  childConfigs: Map<Address, Exclude<HookConfig, string>>;
}

interface RecoveredHookContext {
  expectedMailbox?: Address;
  configs: Map<string, Exclude<HookConfig, string>>;
  routingHooks: Map<string, RecoveredRoutingHookState>;
}

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

    // Configs carrying an `address` reference an already-deployed hook:
    // recover the existing contract instead of deploying a new one.
    const existingHookAddress = configuredHookAddress(config);
    if (existingHookAddress && RECOVERABLE_HOOK_TYPES.includes(config.type)) {
      const context: RecoveredHookContext = {
        expectedMailbox: coreAddresses.mailbox,
        configs: new Map(),
        routingHooks: new Map(),
      };
      await this.validateRecoveredHook(
        chain,
        config,
        existingHookAddress,
        context,
      );
      await this.reconcileRecoveredHook(
        chain,
        config,
        existingHookAddress,
        new Set<string>(),
        context,
      );
      const signerOrProvider = this.multiProvider.getSignerOrProvider(chain);
      const hook = (() => {
        switch (config.type) {
          case HookType.MERKLE_TREE:
            return MerkleTreeHook__factory.connect(
              existingHookAddress,
              signerOrProvider,
            );
          case HookType.AGGREGATION:
            return StaticAggregationHook__factory.connect(
              existingHookAddress,
              signerOrProvider,
            );
          case HookType.PAUSABLE:
            return PausableHook__factory.connect(
              existingHookAddress,
              signerOrProvider,
            );
          case HookType.ROUTING:
            return DomainRoutingHook__factory.connect(
              existingHookAddress,
              signerOrProvider,
            );
          case HookType.FALLBACK_ROUTING:
            return FallbackDomainRoutingHook__factory.connect(
              existingHookAddress,
              signerOrProvider,
            );
          default:
            throw new Error(`Hook type ${config.type} cannot be recovered`);
        }
      })();
      // CAST: deployers return the subset of HookFactories materialized by the
      // requested config; HyperlaneContracts currently models a complete map.
      const deployedContracts = { [config.type]: hook } as any; // partial
      this.addDeployedContracts(chain, deployedContracts);
      return deployedContracts;
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

  private recoveredOwner(
    config:
      | PausableHookConfig
      | DomainRoutingHookConfig
      | FallbackRoutingHookConfig,
  ) {
    const owner = config.ownerOverrides?.[config.type] ?? config.owner;
    assert(
      !isZeroishAddress(owner),
      `Recovered ${config.type} owner cannot be the zero address`,
    );
    return owner;
  }

  private addRecoveredConfig(
    configs: Map<string, Exclude<HookConfig, string>>,
    address: Address,
    config: Exclude<HookConfig, string>,
  ): boolean {
    const key = address.toLowerCase();
    const existing = configs.get(key);
    assert(
      !existing || deepEquals(existing, config),
      `Recovered hook ${address} has conflicting configs`,
    );
    if (existing) return false;
    configs.set(key, config);
    return true;
  }

  private async validateRecoveredHook(
    chain: ChainName,
    config: Exclude<HookConfig, string>,
    address: Address,
    context: RecoveredHookContext,
  ): Promise<void> {
    if (!this.addRecoveredConfig(context.configs, address, config)) return;

    const expectedType = RECOVERABLE_ONCHAIN_HOOK_TYPES[config.type];
    assert(
      expectedType !== undefined,
      `Hook type ${config.type} cannot be recovered by address`,
    );
    const actualType = await IPostDispatchHook__factory.connect(
      address,
      this.multiProvider.getProvider(chain),
    ).hookType();
    assert(
      actualType === expectedType,
      `Recovered hook ${address} on ${chain} has type ${actualType}, expected ${expectedType}`,
    );

    if (
      config.type === HookType.MERKLE_TREE ||
      config.type === HookType.ROUTING ||
      config.type === HookType.FALLBACK_ROUTING
    ) {
      assert(
        context.expectedMailbox,
        `Mailbox address is required to recover ${config.type}`,
      );
      const actualMailbox = await MailboxClient__factory.connect(
        address,
        this.multiProvider.getProvider(chain),
      ).mailbox();
      assert(
        eqAddress(actualMailbox, context.expectedMailbox),
        `Recovered hook ${address} on ${chain} has mailbox ${actualMailbox}, expected ${context.expectedMailbox}`,
      );
    }

    switch (config.type) {
      case HookType.PAUSABLE:
        await this.validateRecoveredPausableHook(chain, config, address);
        break;
      case HookType.AGGREGATION:
        await this.validateRecoveredAggregationHook(
          chain,
          config,
          address,
          context,
        );
        break;
      case HookType.ROUTING:
      case HookType.FALLBACK_ROUTING:
        await this.validateRecoveredRoutingHook(
          chain,
          config,
          address,
          context,
        );
        break;
      case HookType.MERKLE_TREE:
        break;
      default:
        assert(
          false,
          `Hook type ${config.type} cannot be recovered by address`,
        );
    }
  }

  private async validateRecoveredPausableHook(
    chain: ChainName,
    config: PausableHookConfig,
    address: Address,
  ): Promise<void> {
    const hook = PausableHook__factory.connect(
      address,
      this.multiProvider.getProvider(chain),
    );
    const [currentOwner, currentPaused, signer] = await Promise.all([
      hook.owner(),
      hook.paused(),
      this.multiProvider.getSignerAddress(chain),
    ]);
    assert(
      currentPaused === config.paused,
      `Recovered pausable hook ${address} on ${chain} is ${currentPaused ? '' : 'not '}paused, but config expects ${config.paused ? '' : 'not '}paused`,
    );
    const owner = this.recoveredOwner(config);
    if (!eqAddress(currentOwner, owner)) {
      assert(
        eqAddress(currentOwner, signer),
        `Cannot reconcile recovered pausable hook ${address} on ${chain}: signer ${signer} is not owner ${currentOwner}`,
      );
    }
  }

  private async validateRecoveredAggregationHook(
    chain: ChainName,
    config: AggregationHookConfig,
    address: Address,
    context: RecoveredHookContext,
  ): Promise<void> {
    await this.assertRecoveredAggregationChildren(chain, config, address);
    for (const hookConfig of config.hooks) {
      if (typeof hookConfig === 'string') continue;
      const hookAddress = configuredHookAddress(hookConfig);
      assert(hookAddress, 'Recovered aggregation child address is required');
      await this.validateRecoveredHook(chain, hookConfig, hookAddress, context);
    }
  }

  private async validateRecoveredRoutingHook(
    chain: ChainName,
    config: DomainRoutingHookConfig | FallbackRoutingHookConfig,
    address: Address,
    context: RecoveredHookContext,
  ): Promise<void> {
    const recoveredRoutingHook = await this.readRecoveredRoutingHook(
      chain,
      config,
      address,
    );
    context.routingHooks.set(address.toLowerCase(), recoveredRoutingHook);
    const { routingHook, routingConfigs, childConfigs } = recoveredRoutingHook;
    const [currentOwner, signer] = await Promise.all([
      routingHook.owner(),
      this.multiProvider.getSignerAddress(chain),
    ]);
    const owner = this.recoveredOwner(config);
    if (routingConfigs.length > 0 || !eqAddress(currentOwner, owner)) {
      assert(
        eqAddress(currentOwner, signer),
        `Cannot reconcile recovered routing hook ${address} on ${chain}: signer ${signer} is not owner ${currentOwner}`,
      );
    }

    const batchSize = getTxConfigBatchSize(chain);
    for (let i = 0; i < routingConfigs.length; i += batchSize) {
      await routingHook.estimateGas.setHooks(
        routingConfigs.slice(i, i + batchSize),
      );
    }
    for (const [childAddress, childConfig] of childConfigs) {
      await this.validateRecoveredHook(
        chain,
        childConfig,
        childAddress,
        context,
      );
    }
  }

  private async reconcileRecoveredHook(
    chain: ChainName,
    config: Exclude<HookConfig, string>,
    address: Address,
    reconciled: Set<string>,
    context: RecoveredHookContext,
  ): Promise<void> {
    const key = address.toLowerCase();
    if (reconciled.has(key)) return;
    reconciled.add(key);
    switch (config.type) {
      case HookType.PAUSABLE:
        await this.reconcileRecoveredPausableHook(chain, config, address);
        break;
      case HookType.AGGREGATION:
        await this.reconcileRecoveredAggregationHook(
          chain,
          config,
          address,
          reconciled,
          context,
        );
        break;
      case HookType.ROUTING:
      case HookType.FALLBACK_ROUTING:
        await this.reconcileRecoveredRoutingHook(
          chain,
          config,
          address,
          reconciled,
          context,
        );
        break;
      default:
        break;
    }
  }

  private async reconcileRecoveredPausableHook(
    chain: ChainName,
    config: PausableHookConfig,
    address: Address,
  ): Promise<void> {
    const hook = PausableHook__factory.connect(
      address,
      this.multiProvider.getSignerOrProvider(chain),
    );
    const currentOwner = await hook.owner();
    const owner = this.recoveredOwner(config);
    if (eqAddress(currentOwner, owner)) return;
    const overrides = this.multiProvider.getTransactionOverrides(chain);
    await this.multiProvider.handleTx(
      chain,
      hook.transferOwnership(owner, overrides),
    );
  }

  private async assertRecoveredAggregationChildren(
    chain: ChainName,
    config: AggregationHookConfig,
    address: Address,
  ): Promise<void> {
    const expectedAddresses = config.hooks.map((hookConfig) => {
      const hookAddress = configuredHookAddress(hookConfig);
      assert(
        hookAddress,
        `Recovered aggregation hook ${address} on ${chain} requires addresses for every child`,
      );
      return hookAddress;
    });

    const aggregation = StaticAggregationHook__factory.connect(
      address,
      this.multiProvider.getProvider(chain),
    );
    const actualAddresses = await aggregation.hooks(
      ethers.constants.AddressZero,
    );
    const expectedSorted = [...expectedAddresses].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    const actualSorted = [...actualAddresses].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    assert(
      actualSorted.length === expectedSorted.length &&
        actualSorted.every((hookAddress, index) =>
          eqAddress(hookAddress, expectedSorted[index]),
        ),
      `Recovered aggregation hook ${address} on ${chain} does not contain the configured children`,
    );
  }

  private async reconcileRecoveredAggregationHook(
    chain: ChainName,
    config: AggregationHookConfig,
    address: Address,
    reconciled: Set<string>,
    context: RecoveredHookContext,
  ): Promise<void> {
    for (const hookConfig of config.hooks) {
      if (typeof hookConfig === 'string') continue;
      const hookAddress = configuredHookAddress(hookConfig);
      assert(hookAddress, 'Recovered aggregation child address is required');
      await this.reconcileRecoveredHook(
        chain,
        hookConfig,
        hookAddress,
        reconciled,
        context,
      );
    }
  }

  private async readRecoveredRoutingHook(
    chain: ChainName,
    config: DomainRoutingHookConfig | FallbackRoutingHookConfig,
    address: Address,
  ): Promise<RecoveredRoutingHookState> {
    let routingHook: DomainRoutingHook | FallbackDomainRoutingHook;
    const childConfigs = new Map<string, Exclude<HookConfig, string>>();

    if (config.type === HookType.FALLBACK_ROUTING) {
      const fallbackRoutingHook = FallbackDomainRoutingHook__factory.connect(
        address,
        this.multiProvider.getSignerOrProvider(chain),
      );
      routingHook = fallbackRoutingHook;
      const fallbackAddress = configuredHookAddress(config.fallback);
      assert(
        fallbackAddress,
        `Recovered fallback routing hook ${address} on ${chain} requires a fallback address`,
      );
      const actualFallback = await fallbackRoutingHook.fallbackHook();
      assert(
        eqAddress(actualFallback, fallbackAddress),
        `Recovered fallback routing hook ${address} on ${chain} has fallback ${actualFallback}, expected ${fallbackAddress}`,
      );
      if (typeof config.fallback !== 'string') {
        this.addRecoveredConfig(childConfigs, fallbackAddress, config.fallback);
      }
    } else {
      routingHook = DomainRoutingHook__factory.connect(
        address,
        this.multiProvider.getSignerOrProvider(chain),
      );
    }

    const domainConfigs = Object.entries(config.domains).map(
      ([destination, hookConfig]) => {
        const hookAddress = configuredHookAddress(hookConfig);
        assert(
          hookAddress,
          `Recovered routing hook ${address} on ${chain} requires an address for ${destination}`,
        );
        if (typeof hookConfig !== 'string') {
          this.addRecoveredConfig(childConfigs, hookAddress, hookConfig);
        }

        return {
          destination: this.multiProvider.getDomainId(destination),
          hook: hookAddress,
        };
      },
    );
    const actualHooks = await Promise.all(
      domainConfigs.map(({ destination }) => routingHook.hooks(destination)),
    );
    const routingConfigs = domainConfigs.filter(
      ({ hook }, index) => !eqAddress(actualHooks[index], hook),
    );

    return { routingHook, routingConfigs, childConfigs };
  }

  private async reconcileRecoveredRoutingHook(
    chain: ChainName,
    config: DomainRoutingHookConfig | FallbackRoutingHookConfig,
    address: Address,
    reconciled: Set<string>,
    context: RecoveredHookContext,
  ): Promise<void> {
    const recoveredRoutingHook = context.routingHooks.get(
      address.toLowerCase(),
    );
    assert(
      recoveredRoutingHook,
      `Recovered routing hook ${address} on ${chain} was not validated`,
    );
    const { routingHook, routingConfigs, childConfigs } = recoveredRoutingHook;
    for (const [childAddress, childConfig] of childConfigs) {
      await this.reconcileRecoveredHook(
        chain,
        childConfig,
        childAddress,
        reconciled,
        context,
      );
    }

    const overrides = this.multiProvider.getTransactionOverrides(chain);
    if (routingConfigs.length > 0) {
      await submitBatched(
        chain,
        routingConfigs,
        async (batch) => {
          const estimatedGas = await routingHook.estimateGas.setHooks(batch);
          await this.multiProvider.handleTx(
            chain,
            routingHook.setHooks(batch, {
              gasLimit: addBufferToGasLimit(estimatedGas),
              ...overrides,
            }),
          );
        },
        this.logger,
        'recovered routing hook configs',
      );
    }
    const owner = this.recoveredOwner(config);
    const currentOwner = await routingHook.owner();
    if (!eqAddress(currentOwner, owner)) {
      await this.multiProvider.handleTx(
        chain,
        routingHook.transferOwnership(owner, overrides),
      );
    }
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

      if (hookConfig.type === HookType.PREDICATE) {
        throw new Error(
          'Predicate hooks cannot be deployed via HyperlaneHookDeployer, they must be pre-deployed',
        );
      }
      const subhooks = await this.deployContracts(
        chain,
        hookConfig,
        coreAddresses,
      );
      assert(
        hookConfig.type !== HookType.UNKNOWN,
        `Cannot deploy unknown hook type in aggregation`,
      );
      aggregatedHooks.push(
        subhooks[hookConfig.type as keyof HookFactories].address,
      );
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
          if (config.fallback.type === HookType.PREDICATE) {
            throw new Error(
              'Predicate hooks cannot be deployed via HyperlaneHookDeployer, they must be pre-deployed',
            );
          }
          const fallbackHook = await this.deployContracts(
            chain,
            config.fallback,
            coreAddresses,
          );
          assert(
            config.fallback.type !== HookType.UNKNOWN,
            `Cannot deploy unknown hook type as fallback`,
          );
          fallbackAddress =
            fallbackHook[config.fallback.type as keyof HookFactories].address;
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
        if (hookConfig.type === HookType.PREDICATE) {
          throw new Error(
            'Predicate hooks cannot be deployed via HyperlaneHookDeployer, they must be pre-deployed',
          );
        }
        const hook = await this.deployContracts(
          chain,
          hookConfig,
          coreAddresses,
        );
        assert(
          hookConfig.type !== HookType.UNKNOWN,
          `Cannot deploy unknown hook type for routing destination ${dest}`,
        );
        routingConfigs.push({
          destination: destDomain,
          hook: hook[hookConfig.type as keyof HookFactories].address,
        });
        prevHookConfig = hookConfig;
        prevHookAddress = hook[hookConfig.type as keyof HookFactories].address;
      }
    }

    const overrides = this.multiProvider.getTransactionOverrides(chain);
    await this.runIfOwner(chain, routingHook, async () => {
      await submitBatched(
        chain,
        routingConfigs,
        async (batch) => {
          const estimatedGas = await routingHook.estimateGas.setHooks(batch);
          await this.multiProvider.handleTx(
            chain,
            routingHook.setHooks(batch, {
              gasLimit: addBufferToGasLimit(estimatedGas),
              ...overrides,
            }),
          );
        },
        this.logger,
        'routing hook configs',
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

      if (hookConfig.type === HookType.PREDICATE) {
        throw new Error(
          'Predicate hooks cannot be deployed via HyperlaneHookDeployer, they must be pre-deployed',
        );
      }

      const contracts = await this.deployContracts(
        chain,
        hookConfig,
        this.core[chain],
      );
      assert(
        hookConfig.type !== HookType.UNKNOWN,
        `Cannot deploy unknown hook type in amount routing`,
      );
      hooks.push(contracts[hookConfig.type as keyof HookFactories].address);
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
