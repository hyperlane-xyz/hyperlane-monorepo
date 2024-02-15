import debug, { Debugger } from 'debug';
import { ethers } from 'ethers';

import {
  DefaultFallbackRoutingIsm,
  DefaultFallbackRoutingIsm__factory,
  DomainRoutingIsm,
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
  StaticThresholdAddressSetFactory,
  TestIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  eqAddress,
  objFilter,
  warn,
} from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../app/HyperlaneApp';
import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../consts/environments';
import { appFromAddressesMapHelper } from '../contracts/contracts';
import { HyperlaneAddressesMap } from '../contracts/types';
import {
  ProxyFactoryFactories,
  proxyFactoryFactories,
} from '../deploy/contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import {
  AggregationIsmConfig,
  DeployedIsm,
  DeployedIsmType,
  IsmConfig,
  IsmType,
  MultisigIsmConfig,
  RoutingIsmConfig,
  RoutingIsmDelta,
} from './types';
import { routingModuleDelta } from './utils';

export class HyperlaneIsmFactory extends HyperlaneApp<ProxyFactoryFactories> {
  // The shape of this object is `ChainMap<Address | ChainMap<Address>`,
  // although `any` is use here because that type breaks a lot of signatures.
  // TODO: fix this in the next refactoring
  public deployedIsms: ChainMap<any> = {};

  // upon initialization, HyperlaneDeployer will bind itself to HyperlaneIsmFactory
  deployContractFromFactory?: <F extends ethers.ContractFactory>(
    chain: string,
    factory: F,
    contractName: string,
    constructorArgs: Parameters<F['deploy']>,
    initializeArgs?:
      | Parameters<Awaited<ReturnType<F['deploy']>>['initialize']>
      | undefined,
    shouldRecover?: boolean,
  ) => Promise<ReturnType<F['deploy']>>;

  assertDeployContractFromFactoryIsDefined(): asserts this is {
    deployContractFromFactory: NonNullable<
      HyperlaneIsmFactory['deployContractFromFactory']
    >;
  } {
    if (!this.deployContractFromFactory) {
      throw new Error(
        'IsmFactory not initialised. HyperlaneDeployer must bind deployContractFromFactory to the IsmFactory.',
      );
    }
  }

  static fromEnvironment<Env extends HyperlaneEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
  ): HyperlaneIsmFactory {
    const envAddresses = hyperlaneEnvironments[env];
    if (!envAddresses) {
      throw new Error(`No addresses found for ${env}`);
    }
    /// @ts-ignore
    return HyperlaneIsmFactory.fromAddressesMap(envAddresses, multiProvider);
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
  ): HyperlaneIsmFactory {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      proxyFactoryFactories,
      multiProvider,
    );
    return new HyperlaneIsmFactory(
      helper.contractsMap,
      multiProvider,
      debug('hyperlane:IsmFactoryApp'),
    );
  }

  async deploy<C extends IsmConfig>(params: {
    destination: ChainName;
    config: C;
    origin?: ChainName;
    mailbox?: Address;
    existingIsmAddress?: Address;
  }): Promise<DeployedIsm> {
    this.assertDeployContractFromFactoryIsDefined();

    const { destination, config, origin, mailbox, existingIsmAddress } = params;
    if (typeof config === 'string') {
      // @ts-ignore
      return IInterchainSecurityModule__factory.connect(
        config,
        this.multiProvider.getSignerOrProvider(destination),
      );
    }

    const ismType = config.type;
    const logger = this.logger.extend(`${destination}:${ismType}`);

    logger(
      `Deploying ${ismType} to ${destination} ${
        origin ? `(for verifying ${origin})` : ''
      }`,
    );

    let contract: DeployedIsmType[typeof ismType];
    switch (ismType) {
      case IsmType.MESSAGE_ID_MULTISIG:
      case IsmType.MERKLE_ROOT_MULTISIG:
        contract = await this.deployMultisigIsm(destination, config, logger);
        break;
      case IsmType.ROUTING:
      case IsmType.FALLBACK_ROUTING:
        contract = await this.deployRoutingIsm({
          destination,
          config,
          origin,
          mailbox,
          existingIsmAddress,
          logger,
        });
        break;
      case IsmType.AGGREGATION:
        contract = await this.deployAggregationIsm({
          destination,
          config,
          origin,
          mailbox,
          logger,
        });
        break;
      case IsmType.OP_STACK:
        contract = await this.deployContractFromFactory(
          destination,
          new OPStackIsm__factory(),
          IsmType.OP_STACK,
          [config.nativeBridge],
        );
        break;
      case IsmType.PAUSABLE:
        contract = await this.deployContractFromFactory(
          destination,
          new PausableIsm__factory(),
          IsmType.PAUSABLE,
          [config.owner],
        );
        break;
      case IsmType.TEST_ISM:
        contract = await this.deployContractFromFactory(
          destination,
          new TestIsm__factory(),
          IsmType.TEST_ISM,
          [],
        );
        break;
      default:
        throw new Error(`Unsupported ISM type ${ismType}`);
    }

    if (!this.deployedIsms[destination]) {
      this.deployedIsms[destination] = {};
    }
    if (origin) {
      // if we're deploying network-specific contracts (e.g. ISMs), store them as sub-entry
      // under that network's key (`origin`)
      if (!this.deployedIsms[destination][origin]) {
        this.deployedIsms[destination][origin] = {};
      }
      this.deployedIsms[destination][origin][ismType] = contract;
    } else {
      // otherwise store the entry directly
      this.deployedIsms[destination][ismType] = contract;
    }

    return contract;
  }

  protected async deployMultisigIsm(
    destination: ChainName,
    config: MultisigIsmConfig,
    logger: Debugger,
  ): Promise<IMultisigIsm> {
    this.assertDeployContractFromFactoryIsDefined();

    const signer = this.multiProvider.getSigner(destination);
    const multisigIsmFactory =
      config.type === IsmType.MERKLE_ROOT_MULTISIG
        ? this.getContracts(destination).merkleRootMultisigIsmFactory
        : this.getContracts(destination).messageIdMultisigIsmFactory;

    const address = await this.deployStaticAddressSet(
      destination,
      multisigIsmFactory,
      config.validators,
      logger,
      config.threshold,
    );

    return IMultisigIsm__factory.connect(address, signer);
  }

  protected async deployRoutingIsm(params: {
    destination: ChainName;
    config: RoutingIsmConfig;
    origin?: ChainName;
    mailbox?: Address;
    existingIsmAddress?: Address;
    logger: Debugger;
  }): Promise<IRoutingIsm> {
    this.assertDeployContractFromFactoryIsDefined();

    const { destination, config, mailbox, existingIsmAddress } = params;
    const overrides = this.multiProvider.getTransactionOverrides(destination);
    const routingIsmFactory = this.getContracts(destination).routingIsmFactory;
    let routingIsm: DomainRoutingIsm | DefaultFallbackRoutingIsm;
    // filtering out domains which are not part of the multiprovider
    config.domains = objFilter(
      config.domains,
      (domain, config): config is IsmConfig => {
        const domainId = this.multiProvider.tryGetDomainId(domain);
        if (domainId === null) {
          warn(
            `Domain ${domain} doesn't have chain metadata provided, skipping ...`,
          );
        }
        return domainId !== null;
      },
    );
    const safeConfigDomains = Object.keys(config.domains).map((domain) =>
      this.multiProvider.getDomainId(domain),
    );
    const delta: RoutingIsmDelta = existingIsmAddress
      ? await routingModuleDelta(
          destination,
          existingIsmAddress,
          config,
          this.multiProvider,
          this.getContracts(destination),
          mailbox,
        )
      : {
          domainsToUnenroll: [],
          domainsToEnroll: safeConfigDomains,
        };

    const signer = this.multiProvider.getSigner(destination);
    const provider = this.multiProvider.getProvider(destination);
    let isOwner = false;
    if (existingIsmAddress) {
      const owner = await DomainRoutingIsm__factory.connect(
        existingIsmAddress,
        provider,
      ).owner();
      isOwner = eqAddress(await signer.getAddress(), owner);
    }
    // reconfiguring existing routing ISM
    if (existingIsmAddress && isOwner && !delta.mailbox) {
      const isms: Record<Domain, Address> = {};
      routingIsm = DomainRoutingIsm__factory.connect(
        existingIsmAddress,
        this.multiProvider.getSigner(destination),
      );
      // deploying all the ISMs which have to be updated
      for (const originDomain of delta.domainsToEnroll) {
        const origin = this.multiProvider.getChainName(originDomain); // already filtered to only include domains in the multiprovider
        params.logger(
          `Reconfiguring preexisting routing ISM at for origin ${origin}...`,
        );
        const ism = await this.deploy({
          destination,
          config: config.domains[origin],
          origin,
          mailbox,
        });
        isms[originDomain] = ism.address;
        const tx = await routingIsm.set(
          originDomain,
          isms[originDomain],
          overrides,
        );
        await this.multiProvider.handleTx(destination, tx);
      }
      // unenrolling domains if needed
      for (const originDomain of delta.domainsToUnenroll) {
        params.logger(
          `Unenrolling originDomain ${originDomain} from preexisting routing ISM at ${existingIsmAddress}...`,
        );
        const tx = await routingIsm.remove(originDomain, overrides);
        await this.multiProvider.handleTx(destination, tx);
      }
      // transfer ownership if needed
      if (delta.owner) {
        params.logger(`Transferring ownership of routing ISM...`);
        const tx = await routingIsm.transferOwnership(delta.owner, overrides);
        await this.multiProvider.handleTx(destination, tx);
      }
    } else {
      const isms: ChainMap<Address> = {};
      for (const origin of Object.keys(config.domains)) {
        const ism = await this.deploy({
          destination,
          config: config.domains[origin],
          origin,
          mailbox,
        });
        isms[origin] = ism.address;
      }
      const submoduleAddresses = Object.values(isms);
      let receipt: ethers.providers.TransactionReceipt;
      if (config.type === IsmType.FALLBACK_ROUTING) {
        // deploying new fallback routing ISM
        if (!mailbox) {
          throw new Error(
            'Mailbox address is required for deploying fallback routing ISM',
          );
        }
        params.logger('Deploying fallback routing ISM ...');
        routingIsm = await this.multiProvider.handleDeploy(
          destination,
          new DefaultFallbackRoutingIsm__factory(),
          [mailbox],
        );
        params.logger('Initialising fallback routing ISM ...');
        receipt = await this.multiProvider.handleTx(
          destination,
          routingIsm['initialize(address,uint32[],address[])'](
            config.owner,
            safeConfigDomains,
            submoduleAddresses,
            overrides,
          ),
        );
      } else {
        // deploying new domain routing ISM
        const tx = await routingIsmFactory.deploy(
          config.owner,
          safeConfigDomains,
          submoduleAddresses,
          overrides,
        );
        receipt = await this.multiProvider.handleTx(destination, tx);

        // TODO: Break this out into a generalized function
        const dispatchLogs = receipt.logs
          .map((log) => {
            try {
              return routingIsmFactory.interface.parseLog(log);
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
        routingIsm = DomainRoutingIsm__factory.connect(
          moduleAddress,
          this.multiProvider.getSigner(destination),
        );
      }
    }
    return routingIsm;
  }

  protected async deployAggregationIsm(params: {
    destination: ChainName;
    config: AggregationIsmConfig;
    origin?: ChainName;
    mailbox?: Address;
    logger: Debugger;
  }): Promise<IAggregationIsm> {
    this.assertDeployContractFromFactoryIsDefined();

    const { destination, config, origin, mailbox } = params;
    const signer = this.multiProvider.getSigner(destination);
    const aggregationIsmFactory =
      this.getContracts(destination).aggregationIsmFactory;
    const addresses: Address[] = [];
    for (const module of config.modules) {
      const submodule = await this.deploy({
        destination,
        config: module,
        origin,
        mailbox,
      });
      addresses.push(submodule.address);
    }
    const address = await this.deployStaticAddressSet(
      destination,
      aggregationIsmFactory,
      addresses,
      params.logger,
      config.threshold,
    );
    return IAggregationIsm__factory.connect(address, signer);
  }

  async deployStaticAddressSet(
    chain: ChainName,
    factory: StaticThresholdAddressSetFactory | StaticAddressSetFactory,
    values: Address[],
    logger: Debugger,
    threshold = values.length,
  ): Promise<Address> {
    this.assertDeployContractFromFactoryIsDefined();

    const sorted = [...values].sort();

    const address = await factory['getAddress(address[],uint8)'](
      sorted,
      threshold,
    );
    const code = await this.multiProvider.getProvider(chain).getCode(address);
    if (code === '0x') {
      logger(
        `Deploying new ${threshold} of ${values.length} address set to ${chain}`,
      );
      const overrides = this.multiProvider.getTransactionOverrides(chain);
      const hash = await factory['deploy(address[],uint8)'](
        sorted,
        threshold,
        overrides,
      );
      await this.multiProvider.handleTx(chain, hash);
      // TODO: add proxy verification artifact?
    } else {
      logger(
        `Recovered ${threshold} of ${values.length} address set on ${chain}`,
      );
    }
    return address;
  }
}
