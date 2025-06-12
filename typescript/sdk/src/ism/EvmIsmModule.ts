import { ethers } from 'ethers';
import { Logger } from 'pino';

import {
  DomainRoutingIsm__factory,
  PausableIsm__factory,
  StaticAggregationIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  EvmChainId,
  ProtocolType,
  ZERO_ADDRESS_HEX_32,
  assert,
  deepEquals,
  eqAddress,
  intersection,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { CCIPContractCache } from '../ccip/utils.js';
import { transferOwnershipTransactions } from '../contracts/contracts.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmIsmReader } from './EvmIsmReader.js';
import { HyperlaneIsmFactory } from './HyperlaneIsmFactory.js';
import {
  AggregationIsmConfig,
  DeployedIsm,
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmConfigSchema,
  IsmType,
  MUTABLE_ISM_TYPE,
  PausableIsmConfig,
} from './types.js';
import { calculateDomainRoutingDelta } from './utils.js';

type IsmModuleAddresses = {
  deployedIsm: Address;
  mailbox: Address;
};

export class EvmIsmModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  IsmConfig,
  HyperlaneAddresses<ProxyFactoryFactories> & IsmModuleAddresses
> {
  protected readonly logger = rootLogger.child({ module: 'EvmIsmModule' });
  protected readonly reader: EvmIsmReader;
  protected readonly ismFactory: HyperlaneIsmFactory;
  protected readonly mailbox: Address;

  // Adding these to reduce how often we need to grab from MultiProvider.
  public readonly chain: ChainName;
  public readonly chainId: EvmChainId;
  public readonly domainId: Domain;

  constructor(
    protected readonly multiProvider: MultiProvider,
    params: HyperlaneModuleParams<
      IsmConfig,
      HyperlaneAddresses<ProxyFactoryFactories> & IsmModuleAddresses
    >,
    ccipContractCache?: CCIPContractCache,
    protected readonly contractVerifier?: ContractVerifier,
  ) {
    params.config = IsmConfigSchema.parse(params.config);
    super(params);

    this.reader = new EvmIsmReader(multiProvider, params.chain);

    this.ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      { [params.chain]: params.addresses },
      multiProvider,
      ccipContractCache,
      contractVerifier,
    );

    this.mailbox = params.addresses.mailbox;

    this.chain = multiProvider.getChainName(this.args.chain);
    this.chainId = multiProvider.getEvmChainId(this.chain);
    this.domainId = multiProvider.getDomainId(this.chain);
  }

  public async read(): Promise<IsmConfig> {
    return typeof this.args.config === 'string'
      ? this.args.addresses.deployedIsm
      : this.reader.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  // whoever calls update() needs to ensure that targetConfig has a valid owner
  public async update(
    targetConfig: IsmConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    targetConfig = IsmConfigSchema.parse(targetConfig);

    // Do not support updating to a custom ISM address
    if (typeof targetConfig === 'string') {
      throw new Error(
        'Invalid targetConfig: Updating to a custom ISM address is not supported. Please provide a valid ISM configuration.',
      );
    }

    // save current config for comparison
    // normalize the config to ensure it's in a consistent format for comparison
    const currentConfig = normalizeConfig(await this.read());
    // Update the config
    this.args.config = targetConfig;
    targetConfig = normalizeConfig(targetConfig);

    assert(
      typeof targetConfig === 'object',
      'normalized targetConfig should be an object',
    );

    // If configs match, no updates needed
    if (deepEquals(currentConfig, targetConfig)) {
      return [];
    }

    // Special handling for aggregation ISMs
    if (
      typeof currentConfig === 'object' &&
      currentConfig.type === IsmType.AGGREGATION &&
      targetConfig.type === IsmType.AGGREGATION
    ) {
      return this.updateAggregationIsm({
        current: currentConfig,
        target: targetConfig,
      });
    }

    // Check if we need to deploy a new ISM
    if (
      // if updating from an address/custom config to a proper ISM config, do a new deploy
      typeof currentConfig === 'string' ||
      // if updating a proper ISM config whose types are different, do a new deploy
      currentConfig.type !== targetConfig.type ||
      // if it is not a mutable ISM, do a new deploy
      !MUTABLE_ISM_TYPE.includes(targetConfig.type)
    ) {
      const contract = await this.deploy({
        config: targetConfig,
      });

      this.args.addresses.deployedIsm = contract.address;
      return [];
    }

    // At this point, only the 3 ownable/mutable ISM types should remain: PAUSABLE, ROUTING, FALLBACK_ROUTING
    if (
      targetConfig.type !== IsmType.PAUSABLE &&
      targetConfig.type !== IsmType.ROUTING &&
      targetConfig.type !== IsmType.FALLBACK_ROUTING
    ) {
      throw new Error(`Unsupported ISM type ${targetConfig.type}`);
    }

    const logger = this.logger.child({
      destination: this.chain,
      ismType: targetConfig.type,
    });
    logger.debug(`Updating ${targetConfig.type} on ${this.chain}`);

    // if it's either of the routing ISMs, update their submodules
    let updateTxs: AnnotatedEV5Transaction[] = [];
    if (
      targetConfig.type === IsmType.ROUTING ||
      targetConfig.type === IsmType.FALLBACK_ROUTING
    ) {
      updateTxs = await this.updateRoutingIsm({
        current: currentConfig,
        target: targetConfig,
        logger,
      });
    } else if (targetConfig.type === IsmType.PAUSABLE) {
      updateTxs = await this.updatePausableIsm({
        current: currentConfig,
        target: targetConfig,
      });
    }

    // Lastly, check if the resolved owner is different from the current owner
    updateTxs.push(
      ...transferOwnershipTransactions(
        this.chainId,
        this.args.addresses.deployedIsm,
        currentConfig,
        targetConfig,
      ),
    );

    return updateTxs;
  }

  /**
   * Updates an aggregation ISM by updating mutable components in-place when possible
   */
  protected async updateAggregationIsm({
    current,
    target,
  }: {
    current: AggregationIsmConfig;
    target: AggregationIsmConfig;
  }): Promise<AnnotatedEV5Transaction[]> {
    const logger = this.logger.child({
      destination: this.chain,
      ismType: 'aggregation',
    });

    // If threshold changed or module count changed, redeploy the entire aggregation
    if (
      current.threshold !== target.threshold ||
      current.modules.length !== target.modules.length
    ) {
      logger.debug(
        'Threshold or module count changed, redeploying aggregation ISM',
      );
      const contract = await this.deploy({ config: target });
      this.args.addresses.deployedIsm = contract.address;
      return [];
    }

    let hasStructuralChange = false;
    const updateTxs: AnnotatedEV5Transaction[] = [];

    const [ismAddresses, _] = await StaticAggregationIsm__factory.connect(
      this.args.addresses.deployedIsm,
      this.multiProvider.getProvider(this.chain),
    ).modulesAndThreshold(ZERO_ADDRESS_HEX_32);

    const ismConfigMap: Record<string, number> = {};

    for (const ism of ismAddresses) {
      const derivedIsmConfig =
        await this.reader.deriveIsmConfigFromAddress(ism);
      const normalizedIsmConfig = normalizeConfig(derivedIsmConfig);

      const ismIndex = current.modules.findIndex((h) =>
        deepEquals(h, normalizedIsmConfig),
      );
      if (ismIndex === -1) {
        hasStructuralChange = true;
        break;
      }

      ismConfigMap[ism] = ismIndex;
    }

    // Check each module to see if we can update in place
    for (const [ismAddress, ismIndex] of Object.entries(ismConfigMap)) {
      if (hasStructuralChange) {
        break;
      }

      const currentModule = normalizeConfig(current.modules[ismIndex]);
      const targetModule = normalizeConfig(target.modules[ismIndex]);

      // If modules are identical, skip
      if (deepEquals(currentModule, targetModule)) {
        continue;
      }

      // If module types are different or module is not mutable, mark as structural change
      if (
        typeof currentModule === 'string' ||
        typeof targetModule === 'string' ||
        currentModule.type !== targetModule.type ||
        !MUTABLE_ISM_TYPE.includes(targetModule.type)
      ) {
        hasStructuralChange = true;
        break;
      }

      // Module is mutable and only config changed - update in place
      logger.debug(
        `Updating module ${ismIndex} (${targetModule.type}) in place`,
      );

      // Create a temporary ISM module instance for this component
      const moduleInstance = new EvmIsmModule(
        this.multiProvider,
        {
          addresses: {
            ...this.args.addresses,
            deployedIsm: ismAddress,
          },
          chain: this.args.chain,
          config: currentModule,
        },
        undefined, // ccipContractCache
        this.contractVerifier,
      );

      // Update the module in place
      const moduleTxs = await moduleInstance.update(targetModule);

      // If the address changed, update the config to reuse the deployed module
      if (!eqAddress(moduleInstance.args.addresses.deployedIsm, ismAddress)) {
        hasStructuralChange = true;
        // Update the target config to reuse the existing deployed module address
        target.modules[ismIndex] = moduleInstance.args.addresses.deployedIsm;
        break;
      }

      // Finally, push the module updates
      updateTxs.push(...moduleTxs);
    }

    // If there were structural changes, redeploy the entire aggregation
    if (hasStructuralChange) {
      logger.debug('Structural changes detected, redeploying aggregation ISM');
      const contract = await this.deploy({ config: target });
      this.args.addresses.deployedIsm = contract.address;
      return [];
    }

    return updateTxs;
  }

  // manually write static create function
  public static async create({
    chain,
    config,
    proxyFactoryFactories,
    mailbox,
    multiProvider,
    ccipContractCache,
    contractVerifier,
  }: {
    chain: ChainNameOrId;
    config: IsmConfig;
    proxyFactoryFactories: HyperlaneAddresses<ProxyFactoryFactories>;
    mailbox: Address;
    multiProvider: MultiProvider;
    ccipContractCache?: CCIPContractCache;
    contractVerifier?: ContractVerifier;
  }): Promise<EvmIsmModule> {
    const module = new EvmIsmModule(
      multiProvider,
      {
        addresses: {
          ...proxyFactoryFactories,
          mailbox,
          deployedIsm: ethers.constants.AddressZero,
        },
        chain,
        config,
      },
      ccipContractCache,
      contractVerifier,
    );

    const deployedIsm = await module.deploy({ config });
    module.args.addresses.deployedIsm = deployedIsm.address;

    return module;
  }

  protected async updatePausableIsm({
    current,
    target,
  }: {
    current: PausableIsmConfig;
    target: PausableIsmConfig;
  }): Promise<AnnotatedEV5Transaction[]> {
    const updateTxs: AnnotatedEV5Transaction[] = [];

    if (current.paused !== target.paused) {
      // Have to encode separately otherwise tsc will complain
      // about being unable to infer types correctly
      const pausableInterface = PausableIsm__factory.createInterface();
      const data = target.paused
        ? pausableInterface.encodeFunctionData('pause')
        : pausableInterface.encodeFunctionData('unpause');

      updateTxs.push({
        annotation: `Updating paused state to ${target.paused}`,
        chainId: this.chainId,
        to: this.args.addresses.deployedIsm,
        data,
      });
    }

    return updateTxs;
  }

  protected async updateRoutingIsm({
    current,
    target,
    logger,
  }: {
    current: DomainRoutingIsmConfig;
    target: DomainRoutingIsmConfig;
    logger: Logger;
  }): Promise<AnnotatedEV5Transaction[]> {
    const contract = DomainRoutingIsm__factory.connect(
      this.args.addresses.deployedIsm,
      this.multiProvider.getProvider(this.chain),
    );

    const updateTxs: AnnotatedEV5Transaction[] = [];

    const knownChains = new Set(this.multiProvider.getKnownChainNames());

    const { domainsToEnroll, domainsToUnenroll } = calculateDomainRoutingDelta(
      current,
      target,
    );

    const knownEnrolls = intersection(knownChains, new Set(domainsToEnroll));

    // Enroll domains
    for (const origin of knownEnrolls) {
      logger.debug(
        `Reconfiguring preexisting routing ISM for origin ${origin}...`,
      );
      const ism = await this.deploy({
        config: target.domains[origin],
      });

      const domainId = this.multiProvider.getDomainId(origin);
      const tx = await contract.populateTransaction.set(domainId, ism.address);
      updateTxs.push({
        chainId: this.chainId,
        annotation: `Setting new ISM for origin ${origin}...`,
        ...tx,
      });
    }

    const knownUnenrolls = intersection(
      knownChains,
      new Set(domainsToUnenroll),
    );

    // Unenroll domains
    for (const origin of knownUnenrolls) {
      const domainId = this.multiProvider.getDomainId(origin);
      const tx = await contract.populateTransaction.remove(domainId);
      updateTxs.push({
        chainId: this.chainId,
        annotation: `Unenrolling originDomain ${domainId} from preexisting routing ISM at ${this.args.addresses.deployedIsm}...`,
        ...tx,
      });
    }

    return updateTxs;
  }

  protected async deploy({
    config,
  }: {
    config: IsmConfig;
  }): Promise<DeployedIsm> {
    config = IsmConfigSchema.parse(config);

    return this.ismFactory.deploy({
      destination: this.chain,
      config,
      mailbox: this.mailbox,
    });
  }
}
