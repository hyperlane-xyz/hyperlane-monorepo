import { Debugger, debug } from 'debug';
import { Contract, ethers } from 'ethers';

import {
  Create2Factory__factory,
  HyperlaneConnectionClient,
  Ownable,
  ProxyAdmin,
  ProxyAdmin__factory,
  TransparentUpgradeableProxy,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';
import { types, utils } from '@hyperlane-xyz/utils';

import {
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
  connectContractsMap,
} from '../contracts';
import { HyperlaneAddressesMap } from '../contracts';
import { attachContractsMap } from '../contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { ConnectionClientConfig } from '../router/types';
import { ChainMap, ChainName } from '../types';

import { proxyAdmin } from './proxy';
import { ContractVerificationInput } from './verify/types';
import {
  buildVerificationInput,
  getContractVerificationInput,
} from './verify/utils';

export interface DeployerOptions {
  logger?: Debugger;
  chainTimeoutMs?: number;
}

export interface DeployOptions {
  create2Salt?: string;
  initCalldata?: string;
}

export const CREATE2FACTORY_ADDRESS =
  '0xc97D8e6f57b0d64971453dDc6EB8483fec9d163a';

export abstract class HyperlaneDeployer<
  Config,
  Factories extends HyperlaneFactories,
> {
  public verificationInputs: ChainMap<ContractVerificationInput[]> = {};
  public deployedContracts: HyperlaneContractsMap<Factories> = {};
  public startingBlockNumbers: ChainMap<number | undefined> = {};

  protected logger: Debugger;
  protected chainTimeoutMs: number;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly factories: Factories,
    protected readonly options?: DeployerOptions,
  ) {
    this.logger = options?.logger ?? debug('hyperlane:deployer');
    this.chainTimeoutMs = options?.chainTimeoutMs ?? 5 * 60 * 1000; // 5 minute timeout per chain
  }

  cacheContracts(partialDeployment: HyperlaneContractsMap<Factories>): void {
    this.deployedContracts = connectContractsMap(
      partialDeployment,
      this.multiProvider,
    );
  }

  cacheAddresses(partialDeployment: HyperlaneAddressesMap<Factories>): void {
    this.cacheContracts(attachContractsMap(partialDeployment, this.factories));
  }

  abstract deployContracts(
    chain: ChainName,
    config: Config,
  ): Promise<HyperlaneContracts<Factories>>;

  async deploy(
    configMap: ChainMap<Config>,
  ): Promise<HyperlaneContractsMap<Factories>> {
    const configChains = Object.keys(configMap);
    const targetChains = this.multiProvider.intersect(
      configChains,
      true,
    ).intersection;

    this.logger(`Start deploy to ${targetChains}`);
    for (const chain of targetChains) {
      const signerUrl = await this.multiProvider.tryGetExplorerAddressUrl(
        chain,
      );
      this.logger(`Deploying to ${chain} from ${signerUrl}`);
      this.startingBlockNumbers[chain] = await this.multiProvider
        .getProvider(chain)
        .getBlockNumber();
      await utils.runWithTimeout(this.chainTimeoutMs, async () => {
        this.deployedContracts[chain] = await this.deployContracts(
          chain,
          configMap[chain],
        );
      });
    }
    return this.deployedContracts;
  }

  protected async runIf<T>(
    chain: ChainName,
    address: string,
    fn: () => Promise<T>,
    label = 'address',
  ): Promise<T | undefined> {
    const signer = await this.multiProvider.getSignerAddress(chain);
    if (utils.eqAddress(address, signer)) {
      return fn();
    } else {
      this.logger(`Signer (${signer}) does not match ${label} (${address})`);
    }
    return undefined;
  }

  protected async runIfOwner<T>(
    chain: ChainName,
    ownable: Ownable,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    return this.runIf(chain, await ownable.callStatic.owner(), fn, 'owner');
  }

  protected async runIfAdmin<T>(
    chain: ChainName,
    proxy: Contract,
    signerAdminFn: () => Promise<T>,
    proxyAdminOwnerFn: (proxyAdmin: ProxyAdmin) => Promise<T>,
  ): Promise<T | undefined> {
    const admin = await proxyAdmin(
      this.multiProvider.getProvider(chain),
      proxy.address,
    );
    const code = await this.multiProvider.getProvider(chain).getCode(admin);
    // if admin is a ProxyAdmin, run the proxyAdminOwnerFn (if deployer is owner)
    if (code !== '0x') {
      this.logger(`Admin is a ProxyAdmin (${admin})`);
      const proxyAdmin = ProxyAdmin__factory.connect(admin, proxy.signer);
      return this.runIfOwner(chain, proxyAdmin, () =>
        proxyAdminOwnerFn(proxyAdmin),
      );
    } else {
      this.logger(`Admin is an EOA (${admin})`);
      // if admin is an EOA, run the signerAdminFn (if deployer is admin)
      return this.runIf(chain, admin, () => signerAdminFn(), 'admin');
    }
  }

  protected async initConnectionClient(
    local: ChainName,
    connectionClient: HyperlaneConnectionClient,
    config: ConnectionClientConfig,
  ): Promise<void> {
    this.logger(`Initializing connection client on ${local}...`);
    return this.runIfOwner(local, connectionClient, async () => {
      // set mailbox if not already set (and configured)
      if (config.mailbox !== (await connectionClient.mailbox())) {
        this.logger(`Set mailbox on (${local})`);
        await this.multiProvider.handleTx(
          local,
          connectionClient.setMailbox(config.mailbox),
        );
      }

      // set interchain gas paymaster if not already set (and configured)
      if (
        config.interchainGasPaymaster !==
        (await connectionClient.interchainGasPaymaster())
      ) {
        this.logger(`Set interchain gas paymaster on ${local}`);
        await this.multiProvider.handleTx(
          local,
          connectionClient.setInterchainGasPaymaster(
            config.interchainGasPaymaster,
          ),
        );
      }

      // set interchain security module if not already set (and configured)
      if (
        config.interchainSecurityModule &&
        config.interchainSecurityModule !==
          (await connectionClient.interchainSecurityModule())
      ) {
        this.logger(`Set interchain security module on ${local}`);
        await this.multiProvider.handleTx(
          local,
          connectionClient.setInterchainSecurityModule(
            config.interchainSecurityModule,
          ),
        );
      }
    });
  }

  protected async deployContractFromFactory<F extends ethers.ContractFactory>(
    chain: ChainName,
    factory: F,
    contractName: string,
    constructorArgs: Parameters<F['deploy']>,
    deployOpts?: DeployOptions,
  ): Promise<ReturnType<F['deploy']>> {
    const cachedContract = this.deployedContracts[chain]?.[contractName];
    if (cachedContract) {
      this.logger(
        `Recovered ${contractName} on ${chain} ${cachedContract.address}`,
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

      const input = buildVerificationInput(
        contractName,
        contractAddr,
        encodedConstructorArgs,
      );
      this.verificationInputs[chain] = this.verificationInputs[chain] || [];
      this.verificationInputs[chain].push(input);

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
      this.verificationInputs[chain] = this.verificationInputs[chain] || [];
      this.verificationInputs[chain].push(verificationInput);

      return contract as ReturnType<F['deploy']>;
    }
  }

  async deployContract<K extends keyof Factories>(
    chain: ChainName,
    contractName: K,
    args: Parameters<Factories[K]['deploy']>,
    deployOpts?: DeployOptions,
  ): Promise<HyperlaneContracts<Factories>[K]> {
    const contract = (await this.deployContractFromFactory(
      chain,
      this.factories[contractName],
      contractName.toString(),
      args,
      deployOpts,
    )) as HyperlaneContracts<Factories>[K];
    this.cacheContract(chain, contractName, contract);
    return contract;
  }

  protected async changeAdmin(
    chain: ChainName,
    proxy: TransparentUpgradeableProxy,
    admin: string,
  ): Promise<void> {
    if (utils.eqAddress(admin, await proxy.callStatic.admin())) {
      this.logger(`Admin set correctly, skipping admin change`);
      return;
    }

    this.logger(`Changing proxy admin`);
    await this.runIfAdmin(
      chain,
      proxy,
      () => this.multiProvider.handleTx(chain, proxy.changeAdmin(admin)),
      (proxyAdmin) =>
        this.multiProvider.handleTx(
          chain,
          proxyAdmin.changeProxyAdmin(proxy.address, admin),
        ),
    );
  }

  protected async upgradeAndInitialize(
    chain: ChainName,
    proxy: TransparentUpgradeableProxy,
    implementation: string,
    initData: string,
  ): Promise<void> {
    const curr = await proxy.callStatic.implementation();
    if (utils.eqAddress(implementation, curr)) {
      this.logger(`Implementation set correctly, skipping upgrade`);
      return;
    }

    this.logger(`Upgrading and initializing implementation`);
    await this.runIfAdmin(
      chain,
      proxy,
      () =>
        this.multiProvider.handleTx(
          chain,
          proxy.upgradeToAndCall(implementation, initData),
        ),
      (proxyAdmin: ProxyAdmin) =>
        this.multiProvider.handleTx(
          chain,
          proxyAdmin.upgradeAndCall(proxy.address, implementation, initData),
        ),
    );
  }

  protected async deployProxy<C extends ethers.Contract>(
    chain: ChainName,
    implementation: C,
    initArgs: Parameters<C['initialize']>,
    proxyAdmin: string,
    deployOpts?: DeployOptions,
  ): Promise<C> {
    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );

    let proxy: TransparentUpgradeableProxy;
    const provider = this.multiProvider.getProvider(chain);
    const deployer = await this.multiProvider.getSignerAddress(chain);
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
      // 2. Proxy admin: This will start as the deployer
      //    address. We will use this to initialize before rotating.
      // 3. Initialization data: This will start as null, and we will
      //    initialize our proxied contract manually.
      const constructorArgs: Parameters<
        TransparentUpgradeableProxy__factory['deploy']
      > = [CREATE2FACTORY_ADDRESS, deployer, '0x'];

      // deploy with static implementation, deployer admin, and init data for consistent addresses
      proxy = await this.deployContractFromFactory(
        chain,
        new TransparentUpgradeableProxy__factory(),
        'TransparentUpgradeableProxy',
        constructorArgs,
        deployOpts,
      );
      // upgrade and initialize with actual implementation and init data
      await this.upgradeAndInitialize(
        chain,
        proxy,
        implementation.address,
        initData,
      );
      // rotate admin to the desired admin
      await this.changeAdmin(chain, proxy, proxyAdmin);
    } else {
      const constructorArgs: Parameters<
        TransparentUpgradeableProxy__factory['deploy']
      > = [implementation.address, proxyAdmin, initData];
      proxy = await this.deployContractFromFactory(
        chain,
        new TransparentUpgradeableProxy__factory(),
        'TransparentUpgradeableProxy',
        constructorArgs,
        deployOpts,
      );
    }

    return implementation.attach(proxy.address) as C;
  }

  private cacheContract<K extends keyof Factories>(
    chain: ChainName,
    contractName: K,
    contract: HyperlaneContracts<Factories>[K],
  ) {
    if (!this.deployedContracts[chain]) {
      this.deployedContracts[chain] = {} as HyperlaneContracts<Factories>;
    }
    this.deployedContracts[chain][contractName] = contract;
  }

  /**
   * Deploys the Implementation and Proxy for a given contract
   *
   */
  async deployProxiedContract<K extends keyof Factories>(
    chain: ChainName,
    contractName: K,
    constructorArgs: Parameters<Factories[K]['deploy']>,
    initArgs: Parameters<HyperlaneContracts<Factories>[K]['initialize']>,
    proxyAdmin: string,
    deployOpts?: DeployOptions,
  ): Promise<HyperlaneContracts<Factories>[K]> {
    const cachedProxy = this.deployedContracts[chain]?.[contractName];
    if (cachedProxy) {
      this.logger(
        `Recovered ${contractName as string} on ${chain} ${
          cachedProxy.address
        }`,
      );
      return cachedProxy;
    }

    const implementation = await this.deployContract<K>(
      chain,
      contractName,
      constructorArgs,
      deployOpts,
    );

    const contract = await this.deployProxy(
      chain,
      implementation,
      initArgs,
      proxyAdmin,
      deployOpts,
    );
    this.cacheContract(chain, contractName, contract);
    return contract;
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

  protected async transferOwnershipOfContracts(
    chain: ChainName,
    owner: types.Address,
    ownables: Ownable[],
  ): Promise<ethers.ContractReceipt[]> {
    const receipts: ethers.ContractReceipt[] = [];
    for (const ownable of ownables) {
      const currentOwner = await ownable.owner();
      if (!utils.eqAddress(currentOwner, owner)) {
        const receipt = await this.runIfOwner(chain, ownable, () =>
          this.multiProvider.handleTx(
            chain,
            ownable.transferOwnership(
              owner,
              this.multiProvider.getTransactionOverrides(chain),
            ),
          ),
        );
        if (receipt) receipts.push(receipt);
      }
    }

    return receipts.filter((x) => !!x) as ethers.ContractReceipt[];
  }
}
