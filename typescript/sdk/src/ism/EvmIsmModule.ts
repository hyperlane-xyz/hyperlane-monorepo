import { ethers } from 'ethers';
import { Logger } from 'pino';

import {
  AbstractCcipReadIsm__factory,
  DomainRoutingIsm__factory,
  PausableIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  EvmChainId,
  ProtocolType,
  arrayEqual,
  assert,
  deepEquals,
  intersection,
  isZeroishAddress,
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
  DeployedIsm,
  DerivedIsmConfig,
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmConfigSchema,
  IsmType,
  MUTABLE_ISM_TYPE,
  OffchainLookupIsmConfig,
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

    // Nothing to do if its the default ism
    if (typeof targetConfig === 'string' && isZeroishAddress(targetConfig)) {
      return [];
    }

    // We need to normalize the current and target configs to compare.
    const normalizedTargetConfig: DerivedIsmConfig = normalizeConfig(
      await this.reader.deriveIsmConfig(targetConfig),
    );
    const normalizedCurrentConfig: DerivedIsmConfig | string = normalizeConfig(
      await this.read(),
    );

    // If configs match, no updates needed
    if (deepEquals(normalizedCurrentConfig, normalizedTargetConfig)) {
      return [];
    }

    // Update the module config to the target one as we are sure now that an update will be needed
    this.args.config = normalizedTargetConfig;

    // if the new config is an address just point the module to the new address
    if (typeof normalizedTargetConfig === 'string') {
      this.args.addresses.deployedIsm = normalizedTargetConfig;

      return [];
    }

    // Conditions for deploying a new ISM:
    // - If updating from an address/custom config to a proper ISM config.
    // - If updating a proper ISM config whose types are different.
    // - If it is not a mutable ISM.
    // Else, we have to figure out what an update for this ISM entails
    // Check if we need to deploy a new ISM
    if (
      typeof normalizedCurrentConfig === 'string' ||
      normalizedCurrentConfig.type !== normalizedTargetConfig.type ||
      !MUTABLE_ISM_TYPE.includes(normalizedTargetConfig.type)
    ) {
      const contract = await this.deploy({
        config: normalizedTargetConfig,
      });

      this.args.addresses.deployedIsm = contract.address;
      return [];
    }

    // additional check for deploying new ISM if it is mutable incremental routing
    // and has updates to an existing domain
    if (
      normalizedCurrentConfig.type === IsmType.INCREMENTAL_ROUTING &&
      normalizedTargetConfig.type === IsmType.INCREMENTAL_ROUTING
    ) {
      const hasUpdates =
        calculateDomainRoutingDelta(
          normalizedCurrentConfig,
          normalizedTargetConfig,
        ).domainsToUpdate.length > 0;
      if (hasUpdates) {
        const contract = await this.deploy({
          config: normalizedTargetConfig,
        });
        this.args.addresses.deployedIsm = contract.address;
        return [];
      }
    }

    // At this point, only the ownable/mutable ISM types should remain: PAUSABLE, ROUTING, FALLBACK_ROUTING, OFFCHAIN_LOOKUP
    return this.updateMutableIsm({
      current: normalizedCurrentConfig,
      target: normalizedTargetConfig,
    });
  }

  protected async updateMutableIsm({
    current,
    target,
  }: {
    current: Exclude<IsmConfig, string>;
    target: Exclude<IsmConfig, string>;
  }): Promise<AnnotatedEV5Transaction[]> {
    const updateTxs: AnnotatedEV5Transaction[] = [];

    assert(
      MUTABLE_ISM_TYPE.includes(current.type),
      `Expected mutable ISM type but got ${current.type}`,
    );
    assert(
      current.type === target.type,
      `Updating Mutable ISMs requires both the expected and actual config to be of the same type`,
    );

    const logger = this.logger.child({
      destination: this.chain,
      ismType: target.type,
    });
    logger.debug(`Updating ${target.type} on ${this.chain}`);

    if (
      (current.type === IsmType.ROUTING && target.type === IsmType.ROUTING) ||
      (current.type === IsmType.FALLBACK_ROUTING &&
        target.type === IsmType.FALLBACK_ROUTING) ||
      (current.type === IsmType.INCREMENTAL_ROUTING &&
        target.type === IsmType.INCREMENTAL_ROUTING)
    ) {
      const txs = await this.updateRoutingIsm({
        current,
        target,
        logger,
      });

      updateTxs.push(...txs);
    } else if (
      current.type === IsmType.PAUSABLE &&
      target.type === IsmType.PAUSABLE
    ) {
      updateTxs.push(
        ...this.updatePausableIsm({
          current,
          target,
        }),
      );
    } else if (
      current.type === IsmType.OFFCHAIN_LOOKUP &&
      target.type === IsmType.OFFCHAIN_LOOKUP
    ) {
      updateTxs.push(
        ...this.updateOffchainLookupIsm({
          current,
          target,
        }),
      );
    } else {
      throw new Error(
        `Unsupported update to mutable ISM of type ${target.type}`,
      );
    }

    // Lastly, check if the resolved owner is different from the current owner
    updateTxs.push(
      ...transferOwnershipTransactions(
        this.chainId,
        this.args.addresses.deployedIsm,
        current,
        target,
      ),
    );

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

  protected updatePausableIsm({
    current,
    target,
  }: {
    current: PausableIsmConfig;
    target: PausableIsmConfig;
  }): AnnotatedEV5Transaction[] {
    if (current.paused === target.paused) {
      return [];
    }

    const ismInterface = PausableIsm__factory.createInterface();
    const data = target.paused
      ? ismInterface.encodeFunctionData('pause')
      : ismInterface.encodeFunctionData('unpause');

    return [
      {
        annotation: `${target.paused ? 'Pausing' : 'Unpausing'} Pausable ISM on chain "${this.chain}" and address "${this.args.addresses.deployedIsm}"`,
        chainId: this.multiProvider.getEvmChainId(this.chain),
        to: this.args.addresses.deployedIsm,
        data,
      },
    ];
  }

  protected updateOffchainLookupIsm({
    current,
    target,
  }: {
    current: OffchainLookupIsmConfig;
    target: OffchainLookupIsmConfig;
  }): AnnotatedEV5Transaction[] {
    if (arrayEqual(target.urls, current.urls)) {
      return [];
    }

    return [
      {
        annotation: `Setting urls to ${target.type} ISM on chain "${this.chain}" and address "${this.args.addresses.deployedIsm}"`,
        chainId: this.multiProvider.getEvmChainId(this.chain),
        to: this.args.addresses.deployedIsm,
        // The contract code just replaces the existing array with the new one
        data: AbstractCcipReadIsm__factory.createInterface().encodeFunctionData(
          'setUrls(string[])',
          [target.urls],
        ),
      },
    ];
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
