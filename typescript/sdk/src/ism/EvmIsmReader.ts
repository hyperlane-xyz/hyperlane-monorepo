import { BigNumber, ethers } from 'ethers';

import {
  AbstractCcipReadIsm__factory,
  AbstractRoutingIsm,
  AbstractRoutingIsm__factory,
  AmountRoutingIsm__factory,
  ArbL2ToL1Ism__factory,
  CCIPIsm__factory,
  DefaultFallbackRoutingIsm__factory,
  IInterchainSecurityModule__factory,
  IMultisigIsm__factory,
  IOutbox__factory,
  InterchainAccountRouter__factory,
  OPStackIsm__factory,
  Ownable__factory,
  PausableIsm__factory,
  StaticAggregationIsm__factory,
  TrustedRelayerIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  WithAddress,
  assert,
  concurrentMap,
  getLogLevel,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getChainNameFromCCIPSelector } from '../ccip/utils.js';
import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { DispatchedMessage } from '../core/types.js';
import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainNameOrId } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

import {
  AggregationIsmConfig,
  ArbL2ToL1IsmConfig,
  DerivedIsmConfig,
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmType,
  ModuleType,
  MultisigIsmConfig,
  NullIsmConfig,
  OffchainLookupIsmConfig,
  RoutingIsmConfig,
} from './types.js';

export interface IsmReader {
  deriveIsmConfig(address: Address): Promise<DerivedIsmConfig>;
  deriveOffchainLookupConfig(
    address: string,
  ): Promise<WithAddress<OffchainLookupIsmConfig>>;
  deriveRoutingConfig(address: Address): Promise<WithAddress<DerivedIsmConfig>>;
  deriveAggregationConfig(
    address: Address,
  ): Promise<WithAddress<AggregationIsmConfig>>;
  deriveMultisigConfig(
    address: Address,
  ): Promise<WithAddress<MultisigIsmConfig>>;
  deriveNullConfig(address: Address): Promise<WithAddress<NullIsmConfig>>;
  deriveArbL2ToL1Config(
    address: Address,
  ): Promise<WithAddress<ArbL2ToL1IsmConfig>>;
  assertModuleType(
    moduleType: ModuleType,
    expectedModuleType: ModuleType,
  ): void;
}

export class EvmIsmReader extends HyperlaneReader implements IsmReader {
  protected readonly logger = rootLogger.child({ module: 'EvmIsmReader' });
  protected isZkSyncChain: boolean;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    protected readonly concurrency: number = multiProvider.tryGetRpcConcurrency(
      chain,
    ) ?? DEFAULT_CONTRACT_READ_CONCURRENCY,
    protected readonly messageContext?: DispatchedMessage,
  ) {
    super(multiProvider, chain);

    // So we can distinguish between Storage/Static ISMs
    const chainTechnicalStack = this.multiProvider.getChainMetadata(
      this.chain,
    ).technicalStack;
    this.isZkSyncChain = chainTechnicalStack === ChainTechnicalStack.ZkSync;
  }

  async deriveIsmConfigFromAddress(
    address: Address,
  ): Promise<DerivedIsmConfig> {
    let moduleType: ModuleType | undefined = undefined;
    let derivedIsmConfig: DerivedIsmConfig;
    try {
      const ism = IInterchainSecurityModule__factory.connect(
        address,
        this.provider,
      );
      this.logger.debug('Deriving IsmConfig:', { address });

      // Temporarily turn off SmartProvider logging
      // Provider errors are expected because deriving will call methods that may not exist in the Bytecode
      this.setSmartProviderLogLevel('silent');
      moduleType = await ism.moduleType();

      switch (moduleType) {
        case ModuleType.UNUSED:
          throw new Error('UNUSED does not have a corresponding IsmType');
        case ModuleType.ROUTING:
          // IsmType is either ROUTING or FALLBACK_ROUTING, but that's determined inside deriveRoutingConfig
          derivedIsmConfig = await this.deriveRoutingConfig(address);
          break;
        case ModuleType.AGGREGATION:
          derivedIsmConfig = await this.deriveAggregationConfig(address);
          break;
        case ModuleType.LEGACY_MULTISIG:
          throw new Error('LEGACY_MULTISIG is deprecated and not supported');
        case ModuleType.MERKLE_ROOT_MULTISIG:
        case ModuleType.MESSAGE_ID_MULTISIG:
          derivedIsmConfig = await this.deriveMultisigConfig(address);
          break;
        case ModuleType.NULL:
          derivedIsmConfig = await this.deriveNullConfig(address);
          break;
        case ModuleType.CCIP_READ:
          derivedIsmConfig = await this.deriveOffchainLookupConfig(address);
          break;
        case ModuleType.ARB_L2_TO_L1:
          return this.deriveArbL2ToL1Config(address);
        default:
          throw new Error(`Unknown ISM ModuleType: ${moduleType}`);
      }
    } catch (e: any) {
      const errorMessage = `Failed to derive ISM module type ${moduleType} on ${this.chain} (${address}) :\n\t${e}`;
      this.logger.debug(errorMessage);
      throw new Error(errorMessage);
    } finally {
      this.setSmartProviderLogLevel(getLogLevel()); // returns to original level defined by rootLogger
    }

    return derivedIsmConfig;
  }

  async deriveOffchainLookupConfig(
    address: string,
  ): Promise<WithAddress<OffchainLookupIsmConfig>> {
    const ism = AbstractCcipReadIsm__factory.connect(address, this.provider);

    this.assertModuleType(await ism.moduleType(), ModuleType.CCIP_READ);

    const [urls, owner] = await Promise.all([ism.urls(), ism.owner()]);

    return {
      address,
      type: IsmType.OFFCHAIN_LOOKUP,
      urls,
      owner,
    };
  }

  // expands ISM configs that are set as addresses by deriving the config
  // from the on-chain deployment
  async deriveIsmConfig(config: IsmConfig): Promise<DerivedIsmConfig> {
    if (typeof config === 'string')
      return this.deriveIsmConfigFromAddress(config);

    // Extend the inner isms
    switch (config.type) {
      case IsmType.FALLBACK_ROUTING:
      case IsmType.ROUTING:
        config.domains = await promiseObjAll(
          objMap(config.domains, async (_, ism) => this.deriveIsmConfig(ism)),
        );
        break;
      case IsmType.AGGREGATION:
      case IsmType.STORAGE_AGGREGATION:
        config.modules = await Promise.all(
          config.modules.map(async (ism) => this.deriveIsmConfig(ism)),
        );
        break;
      case IsmType.AMOUNT_ROUTING:
        [config.lowerIsm, config.upperIsm] = await Promise.all([
          this.deriveIsmConfig(config.lowerIsm),
          this.deriveIsmConfig(config.upperIsm),
        ]);
        break;
    }

    return config as DerivedIsmConfig;
  }

  async deriveRoutingConfig(
    address: Address,
  ): Promise<WithAddress<DerivedIsmConfig>> {
    const abstractRoutingIsm = AbstractRoutingIsm__factory.connect(
      address,
      this.provider,
    );

    this.assertModuleType(
      await abstractRoutingIsm.moduleType(),
      ModuleType.ROUTING,
    );

    // check if its the ICA ISM
    try {
      const icaInstance = InterchainAccountRouter__factory.connect(
        address,
        this.provider,
      );
      await icaInstance.CCIP_READ_ISM();
      if (this.messageContext) {
        // Route via the message context to get routed ISM
        const routedIsm = await icaInstance.route(this.messageContext.message);
        return this.deriveIsmConfig(routedIsm);
      }
      // If no message context, just return this ICA ISM placeholder
      return {
        address,
        type: IsmType.INTERCHAIN_ACCOUNT_ROUTING,
        isms: {},
        owner: await icaInstance.owner(),
      };
    } catch {
      this.logger.debug(
        'Error accessing CCIP_READ_ISM property, implying this is not an ICA ISM.',
        address,
      );
    }

    let owner: Address | undefined;
    const ownableIsm = Ownable__factory.connect(address, this.provider);
    try {
      owner = await ownableIsm.owner();
    } catch {
      this.logger.debug(
        'Error accessing owner property, implying that this is not a DefaultFallbackRoutingIsm.',
        address,
      );
    }

    // If the current ISM does not have an owner then it is an Amount Router
    if (!owner) {
      return this.deriveNonOwnableRoutingConfig(address);
    }

    const defaultFallbackIsmInstance =
      DefaultFallbackRoutingIsm__factory.connect(address, this.provider);
    const domainIds = this.messageContext
      ? [BigNumber.from(this.messageContext.parsed.origin)]
      : await defaultFallbackIsmInstance.domains();

    const icaRouter = InterchainAccountRouter__factory.connect(
      address,
      this.provider,
    );
    try {
      await icaRouter.CCIP_READ_ISM();

      return {
        type: IsmType.INTERCHAIN_ACCOUNT_ROUTING,
        isms: await this.deriveRemoteIsmConfigs(
          domainIds,
          abstractRoutingIsm,
          icaRouter.isms,
          // The isms here are deployed on remote chains and can't be derived
          false,
        ),
        address,
        owner,
      };
    } catch {
      this.logger.debug(
        `Error accessing CCIP_READ_ISM property, implying that this is not a InterchainAccountRouterIsm.`,
        address,
      );
    }

    const domains: DomainRoutingIsmConfig['domains'] =
      await this.deriveRemoteIsmConfigs(
        domainIds,
        abstractRoutingIsm,
        defaultFallbackIsmInstance.module,
        true,
      );

    // Fallback routing ISM extends from MailboxClient, default routing
    let ismType = IsmType.FALLBACK_ROUTING;
    try {
      await defaultFallbackIsmInstance.mailbox();
    } catch {
      ismType = IsmType.ROUTING;
      this.logger.debug(
        'Error accessing mailbox property, implying this is not a fallback routing ISM.',
        address,
      );
    }

    return {
      owner,
      address,
      type: ismType,
      domains,
    };
  }

  private async deriveRemoteIsmConfigs(
    domainIds: ethers.BigNumber[],
    contractInstance: AbstractRoutingIsm,
    addressDeriveFunc: (domain: ethers.BigNumberish) => Promise<string>,
    deriveConfig: true,
  ): Promise<ChainMap<IsmConfig>>;
  private async deriveRemoteIsmConfigs(
    domainIds: ethers.BigNumber[],
    contractInstance: AbstractRoutingIsm,
    addressDeriveFunc: (domain: ethers.BigNumberish) => Promise<string>,
    deriveConfig: false,
  ): Promise<ChainMap<string>>;
  private async deriveRemoteIsmConfigs(
    domainIds: ethers.BigNumber[],
    contractInstance: AbstractRoutingIsm,
    addressDeriveFunc: (domain: ethers.BigNumberish) => Promise<string>,
    deriveConfig: boolean,
  ): Promise<ChainMap<IsmConfig>> {
    const res = await concurrentMap(
      this.concurrency,
      domainIds,
      async (domainId): Promise<[string, IsmConfig] | undefined> => {
        const chainName = this.multiProvider.tryGetChainName(
          domainId.toNumber(),
        );
        if (!chainName) {
          this.logger.warn(
            `Unknown domain ID ${domainId}, skipping domain configuration`,
          );
          return;
        }
        const moduleAddress = this.messageContext
          ? await contractInstance.route(this.messageContext.message)
          : await addressDeriveFunc(domainId);

        return [
          chainName,
          deriveConfig
            ? await this.deriveIsmConfig(moduleAddress)
            : moduleAddress,
        ];
      },
    );

    return Object.fromEntries(
      res.filter((curr) => curr) as [string, IsmConfig][],
    );
  }

  private async deriveNonOwnableRoutingConfig(
    address: Address,
  ): Promise<WithAddress<RoutingIsmConfig>> {
    const ism = AmountRoutingIsm__factory.connect(address, this.provider);

    let lowerIsm: Address;
    let upperIsm: Address;
    let threshold: BigNumber;
    try {
      [lowerIsm, upperIsm, threshold] = await Promise.all([
        ism.lower(),
        ism.upper(),
        ism.threshold(),
      ]);
    } catch {
      // If we fail to access AmountRoutingIsm properties, this is likely a legacy InterchainAccountIsm
      this.logger.debug(
        'Error accessing AmountRoutingIsm properties, treating as legacy InterchainAccountIsm.',
        address,
      );

      // return a basic ICA routing config for legacy contracts
      return {
        type: IsmType.INTERCHAIN_ACCOUNT_ROUTING,
        isms: {},
        address,
        owner: ethers.constants.AddressZero,
      };
    }

    return {
      type: IsmType.AMOUNT_ROUTING,
      address,
      lowerIsm: await this.deriveIsmConfig(lowerIsm),
      upperIsm: await this.deriveIsmConfig(upperIsm),
      threshold: threshold.toNumber(),
    };
  }

  async deriveAggregationConfig(
    address: Address,
  ): Promise<WithAddress<AggregationIsmConfig>> {
    const ism = StaticAggregationIsm__factory.connect(address, this.provider);
    this.assertModuleType(await ism.moduleType(), ModuleType.AGGREGATION);

    const [modules, threshold] = await ism.modulesAndThreshold(
      ethers.constants.AddressZero,
    );

    const ismConfigs = await concurrentMap(
      this.concurrency,
      modules,
      async (module) => this.deriveIsmConfig(module),
    );

    // If it's a zkSync chain, it must be a StorageAggregationIsm
    const ismType = this.isZkSyncChain
      ? IsmType.STORAGE_AGGREGATION
      : IsmType.AGGREGATION;

    return {
      address,
      type: ismType,
      modules: ismConfigs,
      threshold,
    };
  }

  async deriveMultisigConfig(
    address: string,
  ): Promise<WithAddress<MultisigIsmConfig>> {
    const ism = IMultisigIsm__factory.connect(address, this.provider);
    const moduleType = await ism.moduleType();
    assert(
      moduleType === ModuleType.MERKLE_ROOT_MULTISIG ||
        moduleType === ModuleType.MESSAGE_ID_MULTISIG,
      `expected module type to be ${ModuleType.MERKLE_ROOT_MULTISIG} or ${ModuleType.MESSAGE_ID_MULTISIG}, got ${moduleType}`,
    );

    let ismType =
      moduleType === ModuleType.MERKLE_ROOT_MULTISIG
        ? IsmType.MERKLE_ROOT_MULTISIG
        : IsmType.MESSAGE_ID_MULTISIG;

    // If it's a zkSync chain, it must be a StorageMultisigIsm
    if (this.isZkSyncChain) {
      ismType =
        moduleType === ModuleType.MERKLE_ROOT_MULTISIG
          ? IsmType.STORAGE_MERKLE_ROOT_MULTISIG
          : IsmType.STORAGE_MESSAGE_ID_MULTISIG;
    }

    const [validators, threshold] = await ism.validatorsAndThreshold(
      ethers.constants.AddressZero,
    );

    return {
      address,
      type: ismType,
      validators,
      threshold,
    };
  }

  async deriveNullConfig(
    address: Address,
  ): Promise<WithAddress<NullIsmConfig>> {
    const ism = IInterchainSecurityModule__factory.connect(
      address,
      this.provider,
    );
    this.assertModuleType(await ism.moduleType(), ModuleType.NULL);

    // if it has trustedRelayer() property --> TRUSTED_RELAYER
    const trustedRelayerIsm = TrustedRelayerIsm__factory.connect(
      address,
      this.provider,
    );

    try {
      const relayer = await trustedRelayerIsm.trustedRelayer();
      return {
        address,
        relayer,
        type: IsmType.TRUSTED_RELAYER,
      };
    } catch {
      this.logger.debug(
        'Error accessing "trustedRelayer" property, implying this is not a Trusted Relayer ISM.',
        address,
      );
    }

    // if it has paused() property --> PAUSABLE
    const pausableIsm = PausableIsm__factory.connect(address, this.provider);
    try {
      const paused = await pausableIsm.paused();
      const owner = await pausableIsm.owner();
      return {
        address,
        owner,
        type: IsmType.PAUSABLE,
        paused,
      };
    } catch {
      this.logger.debug(
        'Error accessing "paused" property, implying this is not a Pausable ISM.',
        address,
      );
    }

    // if it has ccipOrigin property --> CCIP
    const ccipIsm = CCIPIsm__factory.connect(address, this.provider);
    try {
      const ccipOrigin = await ccipIsm.ccipOrigin();
      const originChain = getChainNameFromCCIPSelector(ccipOrigin.toString());
      if (!originChain) {
        throw new Error('Unknown CCIP origin chain');
      }
      return {
        address,
        type: IsmType.CCIP,
        originChain,
      };
    } catch {
      this.logger.debug(
        'Error accessing "ccipOrigin" property, implying this is not a CCIP ISM.',
        address,
      );
    }

    // if it has VERIFIED_MASK_INDEX, it's AbstractMessageIdAuthorizedIsm which means OPStackIsm
    const opStackIsm = OPStackIsm__factory.connect(address, this.provider);
    try {
      await opStackIsm.VERIFIED_MASK_INDEX();
      return {
        address,
        type: IsmType.OP_STACK,
        origin: address,
        nativeBridge: '', // no way to extract native bridge from the ism
      };
    } catch {
      this.logger.debug(
        'Error accessing "VERIFIED_MASK_INDEX" property, implying this is not an OP Stack ISM.',
        address,
      );
    }

    // no specific properties, must be Test ISM
    return {
      address,
      type: IsmType.TEST_ISM,
    };
  }

  async deriveArbL2ToL1Config(
    address: Address,
  ): Promise<WithAddress<ArbL2ToL1IsmConfig>> {
    const ism = ArbL2ToL1Ism__factory.connect(address, this.provider);

    const outbox = await ism.arbOutbox();
    const outboxContract = IOutbox__factory.connect(outbox, this.provider);
    const bridge = await outboxContract.bridge();
    return {
      address,
      type: IsmType.ARB_L2_TO_L1,
      bridge,
    };
  }

  assertModuleType(
    moduleType: ModuleType,
    expectedModuleType: ModuleType,
  ): void {
    assert(
      moduleType === expectedModuleType,
      `expected module type to be ${expectedModuleType}, got ${moduleType}`,
    );
  }
}
