import { ethers, providers } from 'ethers';

import {
  DefaultFallbackRoutingIsm__factory,
  IInterchainSecurityModule__factory,
  IMultisigIsm__factory,
  OPStackIsm__factory,
  PausableIsm__factory,
  StaticAggregationIsm__factory,
  TestIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  WithAddress,
  assert,
  ethersBigNumberReducer,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Chains } from '../consts/chains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import {
  AggregationIsmConfig,
  IsmConfig,
  IsmType,
  ModuleType,
  MultisigIsmConfig,
  OpStackIsmConfig,
  PausableIsmConfig,
  RoutingIsmConfig,
  TestIsmConfig,
} from './types.js';

interface IsmReader<_ extends ProtocolType> {
  deriveIsmConfig(address: Address): Promise<WithAddress<IsmConfig>>;
  deriveRoutingConfig(address: Address): Promise<WithAddress<RoutingIsmConfig>>;
  deriveAggregationConfig(
    address: Address,
  ): Promise<WithAddress<AggregationIsmConfig>>;
  deriveMultisigConfig(
    address: Address,
  ): Promise<WithAddress<MultisigIsmConfig>>;
  deriveNullConfig(
    address: Address,
  ): Promise<WithAddress<PausableIsmConfig | TestIsmConfig | OpStackIsmConfig>>;
}

export class EvmIsmReader implements IsmReader<ProtocolType.Ethereum> {
  protected readonly provider: providers.Provider;
  protected readonly logger = rootLogger.child({ module: 'EvmIsmReader' });

  constructor(
    protected readonly multiProvider: MultiProvider,
    chain: Chains,
    protected readonly disableConcurrency: boolean = false,
  ) {
    this.provider = this.multiProvider.getProvider(chain);
  }

  public static stringifyConfig(config: IsmConfig, space?: number): string {
    return JSON.stringify(config, ethersBigNumberReducer, space);
  }

  async deriveIsmConfig(address: Address): Promise<WithAddress<IsmConfig>> {
    const ism = IInterchainSecurityModule__factory.connect(
      address,
      this.provider,
    );
    const moduleType: ModuleType = await ism.moduleType();

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
        return this.deriveNullConfig(address);
      case ModuleType.CCIP_READ:
        throw new Error('CCIP_READ does not have a corresponding IsmType');
      default:
        throw new Error('Unknown ModuleType');
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

    for (const domainId of await ism.domains()) {
      const chainName = this.multiProvider.getChainName(domainId.toNumber());
      const module = await ism.module(domainId);
      domains[chainName] = await this.deriveIsmConfig(module);
    }

    // Fallback routing ISM extends from MailboxClient, default routign
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
    const ismConfigs = await Promise.all(
      modules.map((ismAddress) => this.deriveIsmConfig(ismAddress)),
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
  ): Promise<
    WithAddress<PausableIsmConfig | TestIsmConfig | OpStackIsmConfig>
  > {
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
        'Error accessing paused property, implying this is not a Pausable ISM.',
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
        'Error accessing VERIFIED_MASK_INDEX property, implying this is not an OP Stack ISM.',
        address,
      );
    }

    // no specific properties, must be Test ISM
    const testIsm = TestIsm__factory.connect(address, this.provider);
    try {
      assert((await testIsm.moduleType()) === ModuleType.NULL);
      return {
        address,
        type: IsmType.TEST_ISM,
      };
    } catch (error) {
      this.logger.debug(
        'Error accessing setVerify property, implying this is not a Test ISM.',
        address,
      );
    }

    // all else fails, throw an error
    throw new Error(`Encountered invalid Null ISM at ${address}`);
  }
}
