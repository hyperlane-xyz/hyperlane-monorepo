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
  Chain extends ChainName,
  Config,
  Contracts extends HyperlaneContracts,
  Factories extends HyperlaneFactories,
> {
  public deployedContracts: Partial<Record<Chain, Partial<Contracts>>> = {};

  verificationInputs: ChainMap<Chain, ContractVerificationInput[]>;
  protected logger: Debugger;

  constructor(
    protected readonly multiProvider: MultiProvider<Chain>,
    protected readonly configMap: ChainMap<Chain, Config>,
    protected readonly factories: Factories,
    protected readonly options?: DeployerOptions,
  ) {
    this.verificationInputs = objMap(configMap, () => []);
    this.logger = options?.logger || debug('hyperlane:AppDeployer');
  }

  abstract deployContracts(chain: Chain, config: Config): Promise<Contracts>;

  async deploy(
    partialDeployment: Partial<Record<Chain, Partial<Contracts>>> = this
      .deployedContracts,
  ): Promise<Record<Chain, Contracts>> {
    objMap(
      partialDeployment as ChainMap<Chain, Contracts>,
      (chain, contracts) => {
        this.logger(
          `Recovering contracts for ${chain} from partial deployment`,
        );
        const chainConnection = this.multiProvider.getChainConnection(chain);
        this.deployedContracts[chain] = connectContracts(
          contracts,
          chainConnection.signer!,
        );
      },
    );
    const configChains = Object.keys(this.configMap) as Chain[];
    const targetChains = this.multiProvider.intersect(
      configChains,
      false,
    ).intersection;

    this.logger(`Start deploy to ${targetChains}`);
    for (const chain of targetChains) {
      const chainConnection = this.multiProvider.getChainConnection(chain);
      const signerUrl = await chainConnection.getAddressUrl();
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
    return this.deployedContracts as ChainMap<Chain, Contracts>;
  }

  protected async runIfOwner<T>(
    chain: Chain,
    ownable: Ownable,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    const dc = this.multiProvider.getChainConnection(chain);
    const address = await dc.signer!.getAddress();
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
    chain: Chain,
    factory: F,
    contractName: string,
    constructorArgs: Parameters<F['deploy']>,
    deployOpts?: DeployOptions,
  ): Promise<ReturnType<F['deploy']>> {
    const cachedContract = this.deployedContracts[chain]?.[contractName];
    if (cachedContract) {
      this.logger(`Recovered contract ${contractName} on ${chain}`);
      return cachedContract as ReturnType<F['deploy']>;
    }

    const chainConnection = this.multiProvider.getChainConnection(chain);
    const signer = chainConnection.signer;
    if (!signer) {
      throw new Error(`No signer for ${chain}`);
    }

    this.logger(`Deploy ${contractName} on ${chain}`);

    if (
      deployOpts &&
      deployOpts.create2Salt &&
      (await chainConnection.provider.getCode(CREATE2FACTORY_ADDRESS)) != '0x'
    ) {
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

      if ((await chainConnection.provider.getCode(contractAddr)) === '0x') {
        const deployTx = deployOpts.initCalldata
          ? await create2Factory.deployAndInit(
              bytecode,
              salt,
              deployOpts.initCalldata,
              chainConnection.overrides,
            )
          : await create2Factory.deploy(
              bytecode,
              salt,
              chainConnection.overrides,
            );
        await chainConnection.handleTx(deployTx);
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
        .deploy(...constructorArgs, chainConnection.overrides);

      await chainConnection.handleTx(contract.deployTransaction);

      if (deployOpts?.initCalldata) {
        this.logger(`Initialize ${contractName} on ${chain}`);
        const initTx = await signer.sendTransaction({
          to: contract.address,
          data: deployOpts.initCalldata,
        });
        await chainConnection.handleTx(initTx);
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
    chain: Chain,
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
    chain: Chain,
    implementation: C,
    deployerOwnedProxyAdmin: ProxyAdmin,
    proxyAdmin: ProxyAdmin,
    initArgs: Parameters<C['initialize']>,
    deployOpts?: DeployOptions,
  ): Promise<ProxiedContract<C, TransparentProxyAddresses>> {
    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    let proxy: TransparentUpgradeableProxy;
    const chainConnection = this.multiProvider.getChainConnection(chain);
    this.logger(`Deploying transparent upgradable proxy`);
    if (
      deployOpts &&
      deployOpts.create2Salt &&
      (await chainConnection.provider.getCode(CREATE2FACTORY_ADDRESS)) != '0x'
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
      const deployer = await this.multiProvider
        .getChainSigner(chain)
        .getAddress();
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
        chainConnection.overrides,
      );
      await chainConnection.handleTx(upgradeAndCallTx);
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

    return new ProxiedContract<C, TransparentProxyAddresses>(
      implementation.attach(proxy.address) as C,
      {
        kind: ProxyKind.Transparent,
        proxy: proxy.address,
        implementation: implementation.address,
      },
    );
  }

  private cacheContract<K extends keyof Factories>(
    chain: Chain,
    contractName: K,
    contract: HyperlaneContract,
  ) {
    if (!this.deployedContracts[chain]) {
      this.deployedContracts[chain] = {};
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
    chain: Chain,
    contractName: K,
    constructorArgs: Parameters<Factories[K]['deploy']>,
    deployerOwnedProxyAdmin: ProxyAdmin,
    proxyAdmin: ProxyAdmin,
    initArgs: Parameters<C['initialize']>,
    deployOpts?: DeployOptions,
  ): Promise<ProxiedContract<C, TransparentProxyAddresses>> {
    const cachedProxy = this.deployedContracts[chain]?.[contractName as any];
    if (cachedProxy) {
      this.logger(`Recovered proxy ${contractName.toString()} on ${chain}`);
      return cachedProxy as ProxiedContract<C, TransparentProxyAddresses>;
    }

    const implementation = await this.deployContract<K>(
      chain,
      contractName,
      constructorArgs,
      deployOpts,
    );

    const contract = await this.deployProxy(
      chain,
      implementation as C,
      deployerOwnedProxyAdmin,
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
    chain: Chain,
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
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const changeAdminTx = await currentProxyAdmin.changeProxyAdmin(
      proxyAddress,
      desiredProxyAdmin.address,
      chainConnection.overrides,
    );
    await chainConnection.handleTx(changeAdminTx);
  }

  mergeWithExistingVerificationInputs(
    existingInputsMap: ChainMap<Chain, ContractVerificationInput[]>,
  ): ChainMap<Chain, ContractVerificationInput[]> {
    const allChains = new Set<Chain>();
    Object.keys(existingInputsMap).forEach((_) => allChains.add(_ as Chain));
    Object.keys(this.verificationInputs).forEach((_) =>
      allChains.add(_ as Chain),
    );

    // @ts-ignore
    const ret: ChainMap<Chain, ContractVerificationInput[]> = {};
    for (const chain of allChains) {
      const existingInputs = existingInputsMap[chain] || [];
      const newInputs = this.verificationInputs[chain] || [];
      ret[chain] = [...existingInputs, ...newInputs];
    }
    return ret;
  }
}
