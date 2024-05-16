import { Signer, ethers } from 'ethers';
import { Logger } from 'pino';

import {
  DefaultFallbackRoutingIsm__factory,
  DomainRoutingIsm,
  DomainRoutingIsmFactory__factory,
  DomainRoutingIsm__factory,
  IAggregationIsm,
  IAggregationIsm__factory,
  IInterchainSecurityModule__factory,
  IMultisigIsm,
  IMultisigIsm__factory,
  IRoutingIsm,
  OPStackIsm__factory,
  PausableIsm__factory,
  StaticAddressSetFactory,
  StaticAggregationIsmFactory__factory,
  StaticMerkleRootMultisigIsmFactory__factory,
  StaticMessageIdMultisigIsmFactory__factory,
  StaticThresholdAddressSetFactory,
  TestIsm__factory,
  TrustedRelayerIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Annotated,
  Domain,
  ProtocolType,
  assert,
  eqAddress,
  objFilter,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { attachAndConnectContracts } from '../contracts/contracts.js';
import { HyperlaneAddresses, HyperlaneContracts } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleArgs,
} from '../core/AbstractHyperlaneModule.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import {
  ProxyFactoryFactories,
  proxyFactoryFactories,
  proxyFactoryImplementations,
} from '../deploy/contracts.js';
import { getContractVerificationInput } from '../deploy/verify/utils.js';
import { resolveOrDeployAccountOwner } from '../index.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  EthersV5Transaction,
  ProviderType,
  createAnnotatedEthersV5Transaction,
} from '../providers/ProviderType.js';
import { ChainMap, ChainName, ChainNameOrId } from '../types.js';

import { EvmIsmReader } from './EvmIsmReader.js';
import {
  AggregationIsmConfig,
  DeployedIsm,
  DeployedIsmType,
  IsmConfig,
  IsmType,
  MultisigIsmConfig,
  RoutingIsmConfig,
  RoutingIsmDelta,
} from './types.js';
import { routingModuleDelta } from './utils.js';

type ExtraArgs = {
  deployedIsm: Address;
  mailbox: Address;
};

export class EvmIsmModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  IsmConfig,
  HyperlaneAddresses<ProxyFactoryFactories> & ExtraArgs
> {
  protected readonly logger = rootLogger.child({ module: 'EvmIsmModule' });
  protected readonly reader: EvmIsmReader;
  protected readonly factories: HyperlaneContracts<ProxyFactoryFactories>;

  // Adding these to reduce how often we need to grab from MultiProvider.
  public readonly chainName: string;
  // We use domainId here because MultiProvider.getDomainId() will always
  // return a number, and EVM the domainId and chainId are the same.
  public readonly domainId: number;

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly deployer: HyperlaneDeployer<any, any>,
    args: HyperlaneModuleArgs<
      IsmConfig,
      HyperlaneAddresses<ProxyFactoryFactories> & ExtraArgs
    >,
  ) {
    super(args);

    this.reader = new EvmIsmReader(multiProvider, args.chain);
    this.factories = attachAndConnectContracts(
      this.args.addresses,
      proxyFactoryFactories,
      multiProvider.getSigner(args.chain),
    );

    this.chainName = this.multiProvider.getChainName(this.args.chain);
    this.domainId = this.multiProvider.getDomainId(this.chainName);
  }

  public async read(): Promise<IsmConfig> {
    return this.reader.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  public async update(
    targetConfig: IsmConfig,
  ): Promise<Annotated<EthersV5Transaction>[]> {
    this.args.config = targetConfig;
    const destination = this.multiProvider.getChainName(this.args.chain);

    // If it's a custom ISM, just update the address
    if (typeof targetConfig === 'string') {
      // TODO: https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773
      this.args.addresses.deployedIsm = targetConfig;
      return [];
    }

    const ismType = targetConfig.type;
    const logger = this.logger.child({ destination, ismType });

    logger.debug(`Updating ${ismType} on ${destination}`);

    // TODO: PausableIsm should have ownership transferred in here not in create/deploy

    // if it's not a routing ISM - deploy a new one!
    if (ismType !== IsmType.ROUTING && ismType !== IsmType.FALLBACK_ROUTING) {
      const contract = await this.deploy({
        config: targetConfig,
      });

      this.args.addresses.deployedIsm = contract.address;
      return [];
    }

    // if it's a routing ISM - update the existing one
    const { deployedIsm, mailbox } = this.args.addresses;

    // filter for known domains
    const { availableDomains, availableDomainIds } =
      this.filterRoutingIsmDomains({
        config: targetConfig,
      });
    targetConfig.domains = availableDomains;

    // compute the delta
    const delta: RoutingIsmDelta = await routingModuleDelta(
      destination,
      deployedIsm,
      targetConfig,
      this.multiProvider,
      this.factories,
      mailbox,
    );

    // get owner and signer
    const signer = this.multiProvider.getSigner(destination);
    const provider = this.multiProvider.getProvider(destination);
    const owner = await DomainRoutingIsm__factory.connect(
      deployedIsm,
      provider,
    ).owner();
    const isOwner = eqAddress(await signer.getAddress(), owner);

    // if possible, reconfigure existing ISM
    if (deployedIsm && isOwner && !delta.mailbox) {
      return await this.updateRoutingIsm({
        delta,
        config: targetConfig,
        mailbox,
        logger,
      });
    }

    // else, deploy a new set of routing ISM submodules
    const submoduleAddresses = await this.deployRoutingIsmSubmodules({
      destination,
      config: targetConfig,
      mailbox,
    });

    const targetOwner = await resolveOrDeployAccountOwner(
      this.multiProvider,
      destination,
      targetConfig.owner,
    );

    // if fallback routing ISM, update in-place with new submodules
    if (targetConfig.type === IsmType.FALLBACK_ROUTING) {
      return this.updateFallbackRoutingIsm({
        owner: targetOwner,
        domainIds: availableDomainIds,
        submoduleAddresses,
        signer,
        logger,
      });
    }

    // else, deploy a new domain routing ISM
    const newIsm = await this.deployDomainRoutingIsm({
      owner: targetOwner,
      domainIds: availableDomainIds,
      submoduleAddresses,
    });

    this.args.addresses.deployedIsm = newIsm.address;
    return [];
  }

  // manually write static create function
  public static async create(params: {
    chain: ChainNameOrId;
    config: IsmConfig;
    deployer: HyperlaneDeployer<any, any>;
    factories: HyperlaneAddresses<ProxyFactoryFactories>;
    mailbox: Address;
    multiProvider: MultiProvider;
  }): Promise<EvmIsmModule> {
    const { chain, config, deployer, factories, mailbox, multiProvider } =
      params;
    const module = new EvmIsmModule(multiProvider, deployer, {
      addresses: {
        ...factories,
        mailbox,
        deployedIsm: '0x',
      },
      chain,
      config,
    });
    const deployedIsm = await module.deploy({ config });
    module.args.addresses.deployedIsm = deployedIsm.address;
    return module;
  }

  protected async updateRoutingIsm(params: {
    delta: RoutingIsmDelta;
    config: RoutingIsmConfig;
    mailbox: Address;
    logger: Logger;
  }): Promise<Annotated<EthersV5Transaction>[]> {
    const { delta, config, logger } = params;

    const deployedIsmAddress = this.args.addresses.deployedIsm;
    const routingIsmInterface = DomainRoutingIsm__factory.createInterface();

    const updateTxs = [];

    // Enroll domains
    for (const originDomain of delta.domainsToEnroll) {
      // get name of origin chain
      const origin = this.multiProvider.getChainName(originDomain);
      logger.debug(
        `Reconfiguring preexisting routing ISM for origin ${origin}...`,
      );
      const ism = await this.deploy({
        config: config.domains[origin],
      });

      const tx: Annotated<EthersV5Transaction> = {
        annotation: `Setting new ISM for origin ${origin}...`,
        type: ProviderType.EthersV5,
        transaction: {
          chainId: this.domainId,
          to: deployedIsmAddress,
          data: routingIsmInterface.encodeFunctionData('set(uint32,address)', [
            originDomain,
            ism.address,
          ]),
        },
      };
      updateTxs.push(tx);
    }

    // Unenroll domains
    for (const originDomain of delta.domainsToUnenroll) {
      const tx: Annotated<EthersV5Transaction> = {
        annotation: `Unenrolling originDomain ${originDomain} from preexisting routing ISM at ${deployedIsmAddress}...`,
        type: ProviderType.EthersV5,
        transaction: {
          chainId: this.domainId,
          to: deployedIsmAddress,
          data: routingIsmInterface.encodeFunctionData('remove(uint32)', [
            originDomain,
          ]),
        },
      };
      updateTxs.push(tx);
    }

    // Transfer ownership if needed
    if (delta.owner) {
      const tx: Annotated<EthersV5Transaction> = {
        annotation: `Transferring ownership of routing ISM...`,
        type: ProviderType.EthersV5,
        transaction: {
          chainId: this.domainId,
          to: deployedIsmAddress,
          data: routingIsmInterface.encodeFunctionData(
            'transferOwnership(address)',
            [delta.owner],
          ),
        },
      };
      updateTxs.push(tx);
    }

    return updateTxs;
  }

  protected updateFallbackRoutingIsm(params: {
    owner: Address;
    domainIds: Domain[];
    submoduleAddresses: Address[];
    signer: Signer;
    logger: Logger;
  }): Annotated<EthersV5Transaction>[] {
    const { owner, domainIds, submoduleAddresses } = params;
    const routingIsmInterface =
      DefaultFallbackRoutingIsm__factory.createInterface();

    const updateTx = createAnnotatedEthersV5Transaction({
      annotation: 'Updating fallback routing ISM ...',
      chainId: this.multiProvider.getDomainId(this.args.chain),
      to: this.args.addresses.deployedIsm,
      data: routingIsmInterface.encodeFunctionData(
        'initialize(address,uint32[],address[])',
        [owner, domainIds, submoduleAddresses],
      ),
    });
    return [updateTx];
  }

  protected async deployRoutingIsmSubmodules(params: {
    destination: ChainName;
    config: RoutingIsmConfig;
    mailbox: Address;
  }): Promise<Address[]> {
    const { config } = params;
    const isms: ChainMap<Address> = {};

    for (const origin of Object.keys(config.domains)) {
      const ism = await this.deploy({
        config: config.domains[origin],
      });
      isms[origin] = ism.address;
    }

    return Object.values(isms);
  }

  protected async deploy<C extends IsmConfig>({
    config,
  }: {
    config: C;
  }): Promise<DeployedIsm> {
    // If it's a custom ISM, just return a base ISM
    if (typeof config === 'string') {
      // TODO: https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773
      // we can remove the ts-ignore once we have a proper type for custom ISMs
      // @ts-ignore
      return IInterchainSecurityModule__factory.connect(
        config,
        this.multiProvider.getSignerOrProvider(this.args.chain),
      );
    }

    const ismType = config.type;
    const logger = rootLogger.child({ chainName: this.chainName, ismType });

    logger.debug(`Deploying ${ismType} to ${this.args.chain}`);

    let contract: DeployedIsmType[typeof ismType];
    switch (ismType) {
      case IsmType.MESSAGE_ID_MULTISIG:
      case IsmType.MERKLE_ROOT_MULTISIG:
        return this.deployMultisigIsm({
          config,
          logger,
        });
      case IsmType.ROUTING:
      case IsmType.FALLBACK_ROUTING:
        return this.deployRoutingIsm({
          config,
          logger,
        });
      case IsmType.AGGREGATION:
        return this.deployAggregationIsm({
          config,
          logger,
        });
      case IsmType.OP_STACK:
        return this.deployer.deployContractFromFactory(
          this.chainName,
          new OPStackIsm__factory(),
          IsmType.OP_STACK,
          [config.nativeBridge],
        );
      case IsmType.PAUSABLE:
        contract = await this.deployer.deployContractFromFactory(
          this.chainName,
          new PausableIsm__factory(),
          IsmType.PAUSABLE,
          [
            await resolveOrDeployAccountOwner(
              this.multiProvider,
              this.chainName,
              config.owner,
            ),
          ],
        );
        await this.deployer.transferOwnershipOfContracts(
          this.chainName,
          config,
          {
            [IsmType.PAUSABLE]: contract,
          },
        );
        return contract;
      case IsmType.TRUSTED_RELAYER:
        assert(
          this.args.addresses.mailbox,
          `Mailbox address is required for deploying ${ismType}`,
        );
        return this.deployer.deployContractFromFactory(
          this.chainName,
          new TrustedRelayerIsm__factory(),
          IsmType.TRUSTED_RELAYER,
          [this.args.addresses.mailbox, config.relayer],
        );
      case IsmType.TEST_ISM:
        return this.deployer.deployContractFromFactory(
          this.chainName,
          new TestIsm__factory(),
          IsmType.TEST_ISM,
          [],
        );
      default:
        throw new Error(`Unsupported ISM type ${ismType}`);
    }
  }

  protected async deployMultisigIsm({
    config,
    logger,
  }: {
    config: MultisigIsmConfig;
    logger: Logger;
  }): Promise<IMultisigIsm> {
    const signer = this.multiProvider.getSigner(this.chainName);
    const factoryName =
      config.type === IsmType.MERKLE_ROOT_MULTISIG
        ? 'staticMerkleRootMultisigIsmFactory'
        : 'staticMessageIdMultisigIsmFactory';

    const address = await EvmIsmModule.deployStaticAddressSet({
      chain: this.chainName,
      factory: this.factories[factoryName],
      values: config.validators,
      logger,
      threshold: config.threshold,
      multiProvider: this.multiProvider,
    });

    const contract = IMultisigIsm__factory.connect(address, signer);
    const bytecode =
      config.type === IsmType.MERKLE_ROOT_MULTISIG
        ? StaticMerkleRootMultisigIsmFactory__factory.bytecode
        : StaticMessageIdMultisigIsmFactory__factory.bytecode;
    const verificationInput = getContractVerificationInput(
      proxyFactoryImplementations[factoryName],
      contract,
      bytecode,
    );

    await this.deployer.verifyContract(
      this.chainName,
      verificationInput,
      logger,
    );

    return contract;
  }

  protected async deployRoutingIsm({
    config,
    logger,
  }: {
    config: RoutingIsmConfig;
    logger: Logger;
  }): Promise<IRoutingIsm> {
    const { availableDomains, availableDomainIds } =
      this.filterRoutingIsmDomains({
        config,
      });
    config.domains = availableDomains;

    const isms: ChainMap<Address> = {};
    const owner = await resolveOrDeployAccountOwner(
      this.multiProvider,
      this.chainName,
      config.owner,
    );

    for (const origin of Object.keys(config.domains)) {
      const ism = await this.deploy({
        config: config.domains[origin],
      });
      isms[origin] = ism.address;
    }

    const submoduleAddresses = Object.values(isms);

    if (config.type === IsmType.FALLBACK_ROUTING) {
      logger.debug('Deploying fallback routing ISM ...');
      return this.multiProvider.handleDeploy(
        this.chainName,
        new DefaultFallbackRoutingIsm__factory(),
        [this.args.addresses.mailbox],
      );
    }

    logger.debug('Deploying domain routing ISM ...');
    return this.deployDomainRoutingIsm({
      owner,
      domainIds: availableDomainIds,
      submoduleAddresses,
    });
  }

  protected async deployDomainRoutingIsm({
    owner,
    domainIds,
    submoduleAddresses,
  }: {
    owner: string;
    domainIds: number[];
    submoduleAddresses: string[];
  }): Promise<DomainRoutingIsm> {
    const overrides = this.multiProvider.getTransactionOverrides(
      this.args.chain,
    );

    const signer = this.multiProvider.getSigner(this.args.chain);
    const domainRoutingIsmFactory = DomainRoutingIsmFactory__factory.connect(
      this.args.addresses.domainRoutingIsmFactory,
      signer,
    );

    // deploying new domain routing ISM
    const tx = await domainRoutingIsmFactory.deploy(
      owner,
      domainIds,
      submoduleAddresses,
      overrides,
    );

    const receipt = await this.multiProvider.handleTx(this.args.chain, tx);

    const dispatchLogs = receipt.logs
      .map((log) => {
        try {
          return domainRoutingIsmFactory.interface.parseLog(log);
        } catch (e) {
          return undefined;
        }
      })
      .filter(
        (log): log is ethers.utils.LogDescription =>
          !!log && log.name === 'ModuleDeployed',
      );

    if (dispatchLogs.length === 0) {
      throw new Error('No ModuleDeployed event found');
    }

    const moduleAddress = dispatchLogs[0].args['module'];
    return DomainRoutingIsm__factory.connect(moduleAddress, signer);
  }

  protected async deployAggregationIsm({
    config,
    logger,
  }: {
    config: AggregationIsmConfig;
    logger: Logger;
  }): Promise<IAggregationIsm> {
    const addresses: Address[] = [];
    for (const module of config.modules) {
      const submodule = await this.deploy({
        config: module,
      });
      addresses.push(submodule.address);
    }

    const factoryName = 'staticAggregationIsmFactory';
    const address = await EvmIsmModule.deployStaticAddressSet({
      chain: this.chainName,
      factory: this.factories[factoryName],
      values: addresses,
      logger: logger,
      threshold: config.threshold,
      multiProvider: this.multiProvider,
    });

    const signer = this.multiProvider.getSigner(this.args.chain);
    const contract = IAggregationIsm__factory.connect(address, signer);

    const verificationInput = getContractVerificationInput(
      proxyFactoryImplementations[factoryName],
      contract,
      StaticAggregationIsmFactory__factory.bytecode,
    );

    await this.deployer.verifyContract(
      this.chainName,
      verificationInput,
      logger,
    );

    return contract;
  }

  // Public so it can be reused by the hook module.
  // Caller of this function is responsible for verifying the contract
  // because they know exactly which factory is being called.
  public static async deployStaticAddressSet(params: {
    chain: ChainName;
    factory: StaticThresholdAddressSetFactory | StaticAddressSetFactory;
    values: Address[];
    logger: Logger;
    threshold?: number;
    multiProvider: MultiProvider;
  }): Promise<Address> {
    const {
      chain,
      factory,
      values,
      logger,
      threshold = values.length,
      multiProvider,
    } = params;
    const sorted = [...values].sort();

    const address = await factory['getAddress(address[],uint8)'](
      sorted,
      threshold,
    );
    const code = await multiProvider.getProvider(chain).getCode(address);
    if (code === '0x') {
      logger.debug(
        `Deploying new ${threshold} of ${values.length} address set to ${chain}`,
      );
      const overrides = multiProvider.getTransactionOverrides(chain);
      const hash = await factory['deploy(address[],uint8)'](
        sorted,
        threshold,
        overrides,
      );
      await multiProvider.handleTx(chain, hash);
    } else {
      logger.debug(
        `Recovered ${threshold} of ${values.length} address set on ${chain}: ${address}`,
      );
    }

    return address;
  }

  // filtering out domains which are not part of the multiprovider
  private filterRoutingIsmDomains({ config }: { config: RoutingIsmConfig }) {
    const availableDomains = objFilter(
      config.domains,
      (domain, _): _ is IsmConfig => this.multiProvider.hasChain(domain),
    );

    const availableDomainIds = Object.keys(config.domains).map((domain) =>
      this.multiProvider.getDomainId(domain),
    );

    return { availableDomains, availableDomainIds };
  }
}
