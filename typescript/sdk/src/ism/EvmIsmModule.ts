import { ethers } from 'ethers';
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
  MailboxClient__factory,
  OPStackIsm__factory,
  Ownable__factory,
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
import { extractOwnerAddress } from '../deploy/types.js';
import { getContractVerificationInput } from '../deploy/verify/utils.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  EthersV5Transaction,
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
import { moduleMatchesConfig, routingModuleDelta } from './utils.js';

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

  // whoever calls update() needs to ensure that targetConfig has a valid owner
  public async update(
    targetConfig: IsmConfig,
  ): Promise<Annotated<EthersV5Transaction>[]> {
    // Update the config in case it's a custom ISM
    this.args.config = targetConfig;

    const currentConfig = await this.read();
    const configMatches = await moduleMatchesConfig(
      this.chainName,
      this.args.addresses.deployedIsm,
      currentConfig,
      this.multiProvider,
      this.factories,
    );

    // If configs match, no updates needed
    if (configMatches) {
      return [];
    }
    // Else, we have to figure out what an update for this ISM entails

    // If target config is a custom ISM, just update the address
    // if config -> custom ISM, update address
    // if custom ISM -> custom ISM, update address
    if (typeof targetConfig === 'string') {
      // TODO: https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773
      this.args.addresses.deployedIsm = targetConfig;
      return [];
    }

    // Check if we need to deploy a new ISM
    if (
      // if custom ISM -> config, do a new deploy
      typeof currentConfig === 'string' ||
      // if config -> config, AND types are different, do a new deploy
      currentConfig.type !== targetConfig.type ||
      // unless the new ISM is a Routing or Pausable ISM, do a new deploy
      (targetConfig.type !== IsmType.ROUTING &&
        targetConfig.type !== IsmType.FALLBACK_ROUTING &&
        targetConfig.type !== IsmType.PAUSABLE)
    ) {
      const contract = await this.deploy({
        config: targetConfig,
      });

      this.args.addresses.deployedIsm = contract.address;
      return [];
    }

    const targetIsmType = targetConfig.type;
    const logger = this.logger.child({
      destination: this.chainName,
      ismType: targetIsmType,
    });
    const provider = this.multiProvider.getProvider(this.chainName);

    logger.debug(`Updating ${targetIsmType} on ${this.chainName}`);

    // get owner
    const owner = await Ownable__factory.connect(
      this.args.addresses.deployedIsm,
      provider,
    ).owner();
    const targetOwner = extractOwnerAddress(targetConfig.owner);

    // Pausable ISMs are ownable, like Routing ISMs
    // Check if the resolved owner is different from the current owner
    // Return an ownership transfer transaction if required
    if (targetIsmType === IsmType.PAUSABLE) {
      if (!eqAddress(targetOwner, owner)) {
        const tx = createAnnotatedEthersV5Transaction({
          annotation: 'Transferring ownership of pausable ISM...',
          chainId: this.domainId,
          to: this.args.addresses.deployedIsm,
          data: Ownable__factory.createInterface().encodeFunctionData(
            'transferOwnership(address)',
            [targetOwner],
          ),
        });
        return [tx];
      }
      // no owner diff == no tx to return
      return [];
    }
    // else if it's a routing ISM - update the existing one

    // filter for known domains
    const { availableDomains } = this.filterRoutingIsmDomains({
      config: targetConfig,
    });
    targetConfig.domains = availableDomains;

    // get current mailbox address
    const client = MailboxClient__factory.connect(
      this.args.addresses.deployedIsm,
      provider,
    );
    const mailboxAddress = await client.mailbox();

    // if mailbox delta, deploy new routing ISM before updating
    if (!eqAddress(mailboxAddress, this.args.addresses.mailbox)) {
      const newIsm = await this.deployRoutingIsm({
        config: targetConfig,
        logger,
      });

      this.args.addresses.deployedIsm = newIsm.address;
    }

    const delta = await routingModuleDelta(
      this.chainName,
      this.args.addresses.deployedIsm,
      targetConfig,
      this.multiProvider,
      this.factories,
      this.args.addresses.mailbox,
    );

    return await this.updateRoutingIsm({
      delta,
      config: targetConfig,
      logger,
    });
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
        deployedIsm: ethers.constants.AddressZero,
      },
      chain,
      config,
    });
    const deployedIsm = await module.deploy({ config });
    module.args.addresses.deployedIsm = deployedIsm.address;
    return module;
  }

  protected async updateRoutingIsm({
    delta,
    config,
    logger,
  }: {
    delta: RoutingIsmDelta;
    config: RoutingIsmConfig;
    logger: Logger;
  }): Promise<Annotated<EthersV5Transaction>[]> {
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

      const tx = createAnnotatedEthersV5Transaction({
        annotation: `Setting new ISM for origin ${origin}...`,
        chainId: this.domainId,
        to: deployedIsmAddress,
        data: routingIsmInterface.encodeFunctionData('set(uint32,address)', [
          originDomain,
          ism.address,
        ]),
      });

      updateTxs.push(tx);
    }

    // Unenroll domains
    for (const originDomain of delta.domainsToUnenroll) {
      const tx = createAnnotatedEthersV5Transaction({
        annotation: `Unenrolling originDomain ${originDomain} from preexisting routing ISM at ${deployedIsmAddress}...`,
        chainId: this.domainId,
        to: deployedIsmAddress,
        data: routingIsmInterface.encodeFunctionData('remove(uint32)', [
          originDomain,
        ]),
      });
      updateTxs.push(tx);
    }

    // Transfer ownership if needed
    if (delta.owner) {
      const tx = createAnnotatedEthersV5Transaction({
        annotation: `Transferring ownership of routing ISM...`,
        chainId: this.domainId,
        to: deployedIsmAddress,
        data: routingIsmInterface.encodeFunctionData(
          'transferOwnership(address)',
          [delta.owner],
        ),
      });
      updateTxs.push(tx);
    }

    return updateTxs;
  }

  protected updateFallbackRoutingIsm({
    owner,
    domainIds,
    submoduleAddresses,
  }: {
    owner: Address;
    domainIds: Domain[];
    submoduleAddresses: Address[];
  }): Annotated<EthersV5Transaction>[] {
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

  protected async deployRoutingIsmSubmodules({
    config,
  }: {
    config: RoutingIsmConfig;
  }): Promise<Address[]> {
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
    const deployerAddress = await this.multiProvider
      .getSigner(this.chainName)
      .getAddress();

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
          [deployerAddress],
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

    const deployerAddress = await this.multiProvider
      .getSigner(this.chainName)
      .getAddress();

    // else, deploy a new set of routing ISM submodules
    const submoduleAddresses = await this.deployRoutingIsmSubmodules({
      config,
    });

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
      owner: deployerAddress,
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
  public static async deployStaticAddressSet({
    chain,
    factory,
    values,
    logger,
    threshold = values.length,
    multiProvider,
  }: {
    chain: ChainName;
    factory: StaticThresholdAddressSetFactory | StaticAddressSetFactory;
    values: Address[];
    logger: Logger;
    threshold?: number;
    multiProvider: MultiProvider;
  }): Promise<Address> {
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
