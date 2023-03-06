import { Debugger, debug } from 'debug';
import { ethers } from 'ethers';

import {
  Create2Factory__factory,
  Ownable,
  ProxyAdmin,
  ProxyAdmin__factory,
  TransparentUpgradeableProxy,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import {
  HyperlaneAddresses,
  HyperlaneContract,
  HyperlaneContracts,
  HyperlaneFactories,
  connectContracts,
  serializeContracts,
} from '../contracts';
import { MultiProvider } from '../providers/MultiProvider';
import {
  ProxiedContract,
  ProxyKind,
  TransparentProxyAddresses,
} from '../proxy';
import { ChainMap, ChainName } from '../types';
import { objMap } from '../utils/objects';

import { ContractVerificationInput } from './verify/types';
import { getContractVerificationInput } from './verify/utils';

export interface DeployerOptions {
  logger?: Debugger;
}

export interface DeployOptions {
  create2Salt?: string;
  initCalldata?: string;
}

export const CREATE2FACTORY_ADDRESS =
  '0xc97D8e6f57b0d64971453dDc6EB8483fec9d163a';

export abstract class HyperlaneDeployer<
  Config,
  Contracts extends HyperlaneContracts,
  Factories extends HyperlaneFactories,
> {
  public deployedContracts: ChainMap<Contracts> = {};
  public verificationInputs: ChainMap<ContractVerificationInput[]>;
  protected logger: Debugger;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly configMap: ChainMap<Config>,
    protected readonly factories: Factories,
    protected readonly options?: DeployerOptions,
  ) {
    this.verificationInputs = objMap(configMap, () => []);
    this.logger = options?.logger || debug('hyperlane:AppDeployer');
  }

  abstract deployContracts(
    chain: ChainName,
    config: Config,
  ): Promise<Contracts>;

  async deploy(
    partialDeployment: ChainMap<Contracts> = this.deployedContracts,
  ): Promise<ChainMap<Contracts>> {
    objMap(partialDeployment, (chain, contracts) => {
      this.logger(`Recovering contracts for ${chain} from partial deployment`);
      const signer = this.multiProvider.getSigner(chain);
      this.deployedContracts[chain] = connectContracts(contracts, signer);
    });
    const configChains = Object.keys(this.configMap);
    const targetChains = this.multiProvider.intersect(
      configChains,
      true,
    ).intersection;

    this.logger(`Start deploy to ${targetChains}`);
    for (const chain of targetChains) {
      const signerUrl = await this.multiProvider.getExplorerAddressUrl(chain);
      this.logger(`Deploying to ${chain} from ${signerUrl} ...`);
      this.deployedContracts[chain] = await this.deployContracts(
        chain,
        this.configMap[chain],
      );
      // TODO: remove these logs once we have better timeouts
      this.logger(
        JSON.stringify(
          serializeContracts(
            (this.deployedContracts[chain] as Contracts) ?? {},
          ),
          null,
          2,
        ),
      );
    }
    return this.deployedContracts;
  }

  protected async runIfOwner<T>(
    chain: ChainName,
    ownable: Ownable,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    const address = await this.multiProvider.getSignerAddress(chain);
    const owner = await ownable.owner();
    const logObj = { owner, signer: address };
    if (address === owner) {
      this.logger('Owner and signer are equal, proceeding', logObj);
      return fn();
    } else {
      this.logger('Owner and signer NOT equal, skipping', logObj);
    }
    return undefined;
  }

  protected async deployContractFromFactory<F extends ethers.ContractFactory>(
    chain: ChainName,
    factory: F,
    contractName: string,
    constructorArgs: Parameters<F['deploy']>,
    deployOpts?: DeployOptions,
  ): Promise<ReturnType<F['deploy']>> {
    const cachedContract = this.deployedContracts[chain]?.[contractName];
    if (cachedContract && !(cachedContract instanceof ProxiedContract)) {
      this.logger(
        `Recovered contract ${contractName} on ${chain}`,
        cachedContract,
      );
      return cachedContract as ReturnType<F['deploy']>;
    }

    const provider = this.multiProvider.getProvider(chain);
    const signer = this.multiProvider.getSigner(chain);
    const overrides = this.multiProvider.getTransactionOverrides(chain);
    this.logger(`Deploy ${contractName} on ${chain}`);
    const factoryCode = await provider.getCode(CREATE2FACTORY_ADDRESS);
    if (deployOpts && deployOpts.create2Salt && factoryCode != '0x') {
      this.logger(`Deploying with CREATE2 factory`);

      const create2Factory = Create2Factory__factory.connect(
        CREATE2FACTORY_ADDRESS,
        signer,
      );
      const salt = ethers.utils.keccak256(
        ethers.utils.hexlify(ethers.utils.toUtf8Bytes(deployOpts.create2Salt)),
      );
      const encodedConstructorArgs =
        factory.interface.encodeDeploy(constructorArgs);
      const bytecode = ethers.utils.hexlify(
        ethers.utils.concat([factory.bytecode, encodedConstructorArgs]),
      );

      // TODO: Maybe recover deployed contracts?
      const contractAddr = await create2Factory.deployedAddress(
        bytecode,
        await signer.getAddress(),
        salt,
      );

      const contractCode = await provider.getCode(contractAddr);
      if (contractCode === '0x') {
        const deployTx = deployOpts.initCalldata
          ? await create2Factory.deployAndInit(
              bytecode,
              salt,
              deployOpts.initCalldata,
              overrides,
            )
          : await create2Factory.deploy(bytecode, salt, overrides);
        await this.multiProvider.handleTx(chain, deployTx);
      } else {
        this.logger(
          `Found contract deployed at CREATE2 address, skipping contract deploy`,
        );
      }

      this.verificationInputs[chain].push({
        name: contractName.charAt(0).toUpperCase() + contractName.slice(1),
        address: contractAddr,
        isProxy: contractName.endsWith('Proxy'),
        constructorArguments: encodedConstructorArgs,
      });

      return factory.attach(contractAddr).connect(signer) as ReturnType<
        F['deploy']
      >;
    } else {
      const contract = await factory
        .connect(signer)
        .deploy(...constructorArgs, overrides);

      await this.multiProvider.handleTx(chain, contract.deployTransaction);

      if (deployOpts?.initCalldata) {
        this.logger(`Initialize ${contractName} on ${chain}`);
        const initTx = await signer.sendTransaction({
          to: contract.address,
          data: deployOpts.initCalldata,
        });
        await this.multiProvider.handleTx(chain, initTx);
      }

      const verificationInput = getContractVerificationInput(
        contractName,
        contract,
        factory.bytecode,
      );
      this.verificationInputs[chain].push(verificationInput);

      return contract as ReturnType<F['deploy']>;
    }
  }

  async deployContract<K extends keyof Factories>(
    chain: ChainName,
    contractName: K,
    args: Parameters<Factories[K]['deploy']>,
    deployOpts?: DeployOptions,
  ): Promise<ReturnType<Factories[K]['deploy']>> {
    const contract = await this.deployContractFromFactory(
      chain,
      this.factories[contractName],
      contractName.toString(),
      args,
      deployOpts,
    );
    this.cacheContract(chain, contractName, contract);
    return contract;
  }

  protected async deployProxy<C extends ethers.Contract>(
    chain: ChainName,
    implementation: C,
    proxyAdmin: ProxyAdmin,
    initArgs: Parameters<C['initialize']>,
    deployOpts?: DeployOptions,
  ): Promise<ProxiedContract<C, TransparentProxyAddresses>> {
    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    let proxy: TransparentUpgradeableProxy;
    const provider = this.multiProvider.getProvider(chain);
    const overrides = this.multiProvider.getTransactionOverrides(chain);
    this.logger(`Deploying transparent upgradable proxy`);
    if (
      deployOpts &&
      deployOpts.create2Salt &&
      (await provider.getCode(CREATE2FACTORY_ADDRESS)) != '0x'
    ) {
      // To get consistent addresses with Create2, we need to use
      // consistent constructor arguments.
      // The three constructor arguments we need to configure are:
      // 1. Proxy implementation: This will start as the Create2Factory
      //    address, as it needs to be a contract address.
      //    After we've taken over as the proxy admin, we will set it
      //    to the proper address.
      // 2. Proxy admin: This will start as the Create2Factory contract
      //    address. We will change this to the proper address atomically.
      // 3. Initialization data: This will start as null, and we will
      //    initialize our proxied contract manually.
      const constructorArgs: Parameters<
        TransparentUpgradeableProxy__factory['deploy']
      > = [CREATE2FACTORY_ADDRESS, CREATE2FACTORY_ADDRESS, '0x'];
      // The proxy admin during deployment must be owned by the deployer.
      // If the canonical proxyAdmin isn't owned by the deployer, we use
      // a temporary deployer-owned proxy admin.
      // Note this requires the proxy contracts to ensure admin power has been
      // transferred to the canonical proxy admin at some point in the future.
      const proxyAdminOwner = await proxyAdmin.owner();
      const deployer = await this.multiProvider.getSignerAddress(chain);
      let deployerOwnedProxyAdmin = proxyAdmin;
      if (proxyAdminOwner.toLowerCase() !== deployer.toLowerCase()) {
        deployerOwnedProxyAdmin = await this.deployContractFromFactory(
          chain,
          new ProxyAdmin__factory(),
          'DeployerOwnedProxyAdmin',
          [],
        );
      }
      // We set the initCallData to atomically change admin to the deployer owned proxyAdmin
      // contract.
      const initCalldata =
        new TransparentUpgradeableProxy__factory().interface.encodeFunctionData(
          'changeAdmin',
          [deployerOwnedProxyAdmin.address],
        );
      proxy = await this.deployContractFromFactory(
        chain,
        new TransparentUpgradeableProxy__factory(),
        'TransparentUpgradeableProxy',
        constructorArgs,
        { ...deployOpts, initCalldata },
      );
      this.logger(`Upgrading and initializing transparent upgradable proxy`);
      // We now have a deployed proxy admin'd by deployerOwnedProxyAdmin.
      // Upgrade its implementation and initialize it
      const upgradeAndCallTx = await deployerOwnedProxyAdmin.upgradeAndCall(
        proxy.address,
        implementation.address,
        initData,
        overrides,
      );
      await this.multiProvider.handleTx(chain, upgradeAndCallTx);
      // Change the proxy admin from deployerOwnedProxyAdmin to proxyAdmin if necessary.
      await this.changeProxyAdmin(
        chain,
        proxy.address,
        deployerOwnedProxyAdmin,
        proxyAdmin,
      );
    } else {
      const constructorArgs: Parameters<
        TransparentUpgradeableProxy__factory['deploy']
      > = [implementation.address, proxyAdmin.address, initData];
      proxy = await this.deployContractFromFactory(
        chain,
        new TransparentUpgradeableProxy__factory(),
        'TransparentUpgradeableProxy',
        constructorArgs,
      );
    }

    return ProxiedContract.fromContract<C, TransparentProxyAddresses>(
      implementation.attach(proxy.address) as C,
      {
        kind: ProxyKind.Transparent,
        proxy: proxy.address,
        implementation: implementation.address,
      },
    );
  }

  private cacheContract<K extends keyof Factories>(
    chain: ChainName,
    contractName: K,
    contract: HyperlaneContract,
  ) {
    if (!this.deployedContracts[chain]) {
      this.deployedContracts[chain] = {} as Contracts;
    }
    // @ts-ignore
    this.deployedContracts[chain][contractName] = contract;
  }

  /**
   * Deploys the Implementation and Proxy for a given contract
   *
   */
  async deployProxiedContract<
    K extends keyof Factories,
    C extends Awaited<ReturnType<Factories[K]['deploy']>>,
  >(
    chain: ChainName,
    contractName: K,
    constructorArgs: Parameters<Factories[K]['deploy']>,
    proxyAdmin: ProxyAdmin,
    initArgs: Parameters<C['initialize']>,
    deployOpts?: DeployOptions,
  ): Promise<ProxiedContract<C, TransparentProxyAddresses>> {
    const cachedProxy = this.deployedContracts[chain]?.[contractName as any];
    if (
      cachedProxy &&
      cachedProxy.addresses.proxy &&
      cachedProxy.addresses.implementation
    ) {
      this.logger(
        `Recovered proxy and implementation ${contractName.toString()} on ${chain}`,
        cachedProxy,
      );
      return cachedProxy as ProxiedContract<C, TransparentProxyAddresses>;
    }

    const implementation = await this.deployContract<K>(
      chain,
      contractName,
      constructorArgs,
      deployOpts,
    );
    // If the proxy already existed in artifacts but the implementation did not,
    // we only deploy the implementation and keep the proxy.
    // Changing the proxy's implementation address on-chain is left to
    // the govern / checker script
    if (cachedProxy && cachedProxy.addresses.proxy) {
      this.logger(
        `Recovered proxy ${contractName.toString()} on ${chain}`,
        cachedProxy,
      );

      cachedProxy.addresses.implementation = implementation.address;
      this.cacheContract(chain, contractName, cachedProxy);
      return cachedProxy as ProxiedContract<C, TransparentProxyAddresses>;
    }

    const contract = await this.deployProxy(
      chain,
      implementation as C,
      proxyAdmin,
      initArgs,
      deployOpts,
    );
    this.cacheContract(chain, contractName, contract);
    return contract;
  }

  /**
   * Changes the proxyAdmin of `proxyAddress` from `currentProxyAdmin` to `desiredProxyAdmin`
   * if the admin is not already the `desiredProxyAdmin`.
   */
  async changeProxyAdmin(
    chain: ChainName,
    proxyAddress: types.Address,
    currentProxyAdmin: ProxyAdmin,
    desiredProxyAdmin: ProxyAdmin,
  ): Promise<void> {
    if (
      currentProxyAdmin.address.toLowerCase() ===
      desiredProxyAdmin.address.toLowerCase()
    ) {
      this.logger('Current proxy admin is the desired proxy admin');
      return;
    }
    this.logger(
      `Transferring proxy admin from ${currentProxyAdmin} to ${desiredProxyAdmin}`,
    );
    const overrides = this.multiProvider.getTransactionOverrides(chain);
    const changeAdminTx = await currentProxyAdmin.changeProxyAdmin(
      proxyAddress,
      desiredProxyAdmin.address,
      overrides,
    );
    await this.multiProvider.handleTx(chain, changeAdminTx);
  }

  mergeWithExistingVerificationInputs(
    existingInputsMap: ChainMap<ContractVerificationInput[]>,
  ): ChainMap<ContractVerificationInput[]> {
    const allChains = new Set<ChainName>();
    Object.keys(existingInputsMap).forEach((_) => allChains.add(_));
    Object.keys(this.verificationInputs).forEach((_) => allChains.add(_));

    const ret: ChainMap<ContractVerificationInput[]> = {};
    for (const chain of allChains) {
      const existingInputs = existingInputsMap[chain] || [];
      const newInputs = this.verificationInputs[chain] || [];
      ret[chain] = [...existingInputs, ...newInputs];
    }
    return ret;
  }

  serializeContracts(): HyperlaneAddresses {
    return serializeContracts(this.deployedContracts);
  }
}
