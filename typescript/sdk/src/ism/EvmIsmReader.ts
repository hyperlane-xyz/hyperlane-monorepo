import { ethers, providers } from 'ethers';

import {
  DefaultFallbackRoutingIsm__factory,
  IInterchainSecurityModule__factory,
  IMultisigIsm__factory,
  OPStackIsm__factory,
  PausableIsm__factory,
  StaticAggregationIsm__factory,
  TestIsm__factory,
  TrustedRelayerIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  WithAddress,
  assert,
  concurrentMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

import {
  AggregationIsmConfig,
  ArbL2ToL1IsmConfig,
  IsmConfig,
  IsmType,
  ModuleType,
  MultisigIsmConfig,
  NullIsmConfig,
  RoutingIsmConfig,
} from './types.js';

export type DerivedIsmConfig = WithAddress<Exclude<IsmConfig, Address>>;

export interface IsmReader {
  deriveIsmConfig(address: Address): Promise<DerivedIsmConfig>;
  deriveRoutingConfig(address: Address): Promise<WithAddress<RoutingIsmConfig>>;
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
}

export class EvmIsmReader implements IsmReader {
  protected readonly provider: providers.Provider;
  protected readonly logger = rootLogger.child({ module: 'EvmIsmReader' });

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    protected readonly concurrency: number = multiProvider.tryGetRpcConcurrency(
      chain,
    ) ?? DEFAULT_CONTRACT_READ_CONCURRENCY,
  ) {
    this.provider = multiProvider.getProvider(chain);
  }

  async deriveIsmConfig(address: Address): Promise<DerivedIsmConfig> {
    const ism = IInterchainSecurityModule__factory.connect(
      address,
      this.provider,
    );
    const moduleType: ModuleType = await ism.moduleType();
    this.logger.debug('Deriving ISM config', { address, moduleType });

    switch (moduleType) {
      case ModuleType.UNUSED:
        throw new Error('UNUSED does not have a corresponding IsmType');
      case ModuleType.ROUTING:
        // IsmType is either ROUTING or FALLBACK_ROUTING, but that's determined inside deriveRoutingConfig
        return this.deriveRoutingConfig(address);
      case ModuleType.AGGREGATION:
        return this.deriveAggregationConfig(address);
      case ModuleType.LEGACY_MULTISIG:
        throw new Error('LEGACY_MULTISIG is deprecated and not supported');
      case ModuleType.MERKLE_ROOT_MULTISIG:
      case ModuleType.MESSAGE_ID_MULTISIG:
        return this.deriveMultisigConfig(address);
      case ModuleType.NULL:
        return {
          type: IsmType.TEST_ISM,
          address,
        };
      // return this.deriveNullConfig(address);
      case ModuleType.CCIP_READ:
        throw new Error('CCIP_READ does not have a corresponding IsmType');
      case ModuleType.ARB_L2_TO_L1:
        return this.deriveArbL2ToL1Config(address);
      default:
        this.logger.warn(`Unknown module type ${moduleType}`, {
          moduleType,
          address,
        });
        return {
          type: moduleType,
          address,
        };
    }
  }

  async deriveRoutingConfig(
    address: Address,
  ): Promise<WithAddress<RoutingIsmConfig>> {
    const ism = DefaultFallbackRoutingIsm__factory.connect(
      address,
      this.provider,
    );
    const owner = await ism.owner();
    assert((await ism.moduleType()) === ModuleType.ROUTING);

    const domains: RoutingIsmConfig['domains'] = {};
    const domainIds = await ism.domains();

    await concurrentMap(this.concurrency, domainIds, async (domainId) => {
      const chainName = this.multiProvider.tryGetChainName(domainId.toNumber());
      if (!chainName) {
        this.logger.warn(
          `Unknown domain ID ${domainId}, skipping domain configuration`,
        );
        return;
      }
      const module = await ism.module(domainId);
      domains[chainName] = await this.deriveIsmConfig(module);
    });

    // Fallback routing ISM extends from MailboxClient, default routing
    let ismType = IsmType.FALLBACK_ROUTING;
    try {
      await ism.mailbox();
    } catch (error) {
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

  async deriveAggregationConfig(
    address: Address,
  ): Promise<WithAddress<AggregationIsmConfig>> {
    const ism = StaticAggregationIsm__factory.connect(address, this.provider);
    assert((await ism.moduleType()) === ModuleType.AGGREGATION);

    const [modules, threshold] = await ism.modulesAndThreshold(
      ethers.constants.AddressZero,
    );

    const ismConfigs = await concurrentMap(
      this.concurrency,
      modules,
      async (module) => this.deriveIsmConfig(module),
    );

    return {
      address,
      type: IsmType.AGGREGATION,
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
    );

    const ismType =
      moduleType === ModuleType.MERKLE_ROOT_MULTISIG
        ? IsmType.MERKLE_ROOT_MULTISIG
        : IsmType.MESSAGE_ID_MULTISIG;

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
    // if it has trustedRelayer() property --> TrustedRelayer ISM
    const trustedRelayerIsm = TrustedRelayerIsm__factory.connect(
      address,
      this.provider,
    );
    try {
      const relayer = await trustedRelayerIsm.trustedRelayer();
      assert((await trustedRelayerIsm.moduleType()) === ModuleType.NULL);
      return {
        address,
        relayer,
        type: IsmType.TRUSTED_RELAYER,
      };
    } catch (error) {
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
      assert((await pausableIsm.moduleType()) === ModuleType.NULL);
      return {
        address,
        owner,
        type: IsmType.PAUSABLE,
        paused,
      };
    } catch (error) {
      this.logger.debug(
        'Error accessing "paused" property, implying this is not a Pausable ISM.',
        address,
      );
    }

    // if it has VERIFIED_MASK_INDEX, it's AbstractMessageIdAuthorizedIsm which means OPStackIsm
    const opStackIsm = OPStackIsm__factory.connect(address, this.provider);
    try {
      assert((await opStackIsm.moduleType()) === ModuleType.NULL);
      await opStackIsm.VERIFIED_MASK_INDEX();
      return {
        address,
        type: IsmType.OP_STACK,
        origin: address,
        nativeBridge: '', // no way to extract native bridge from the ism
      };
    } catch (error) {
      this.logger.debug(
        'Error accessing "VERIFIED_MASK_INDEX" property, implying this is not an OP Stack ISM.',
        address,
      );
    }

    // no specific properties, must be Test ISM
    const testIsm = TestIsm__factory.connect(address, this.provider);
    assert((await testIsm.moduleType()) === ModuleType.NULL);
    return {
      address,
      type: IsmType.TEST_ISM,
    };
  }

  async deriveArbL2ToL1Config(
    address: Address,
  ): Promise<WithAddress<ArbL2ToL1IsmConfig>> {
    return {
      address,
      type: IsmType.ARB_L2_TO_L1,
    };
  }
}
