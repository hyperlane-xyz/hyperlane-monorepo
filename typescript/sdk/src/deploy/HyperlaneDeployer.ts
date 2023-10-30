import { Debugger, debug } from 'debug';
import { Contract, PopulatedTransaction, ethers } from 'ethers';

import {
  MailboxClient,
  Ownable,
  ProxyAdmin,
  ProxyAdmin__factory,
  TimelockController,
  TimelockController__factory,
  TransparentUpgradeableProxy,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  eqAddress,
  runWithTimeout,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
} from '../contracts/types';
import {
  HyperlaneIsmFactory,
  moduleMatchesConfig,
} from '../ism/HyperlaneIsmFactory';
import { IsmConfig } from '../ism/types';
import { MultiProvider } from '../providers/MultiProvider';
import { MailboxClientConfig } from '../router/types';
import { ChainMap, ChainName } from '../types';

import {
  UpgradeConfig,
  isProxy,
  proxyAdmin,
  proxyConstructorArgs,
  proxyImplementation,
} from './proxy';
import { ContractVerificationInput } from './verify/types';
import {
  buildVerificationInput,
  getContractVerificationInput,
} from './verify/utils';

export interface DeployerOptions {
  logger?: Debugger;
  chainTimeoutMs?: number;
  ismFactory?: HyperlaneIsmFactory;
}

export abstract class HyperlaneDeployer<
  Config,
  Factories extends HyperlaneFactories,
> {
  public verificationInputs: ChainMap<ContractVerificationInput[]> = {};
  public cachedAddresses: HyperlaneAddressesMap<any> = {};
  public deployedContracts: HyperlaneContractsMap<Factories> = {};
  public startingBlockNumbers: ChainMap<number | undefined> = {};

  protected logger: Debugger;
  protected chainTimeoutMs: number;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly factories: Factories,
    protected readonly options?: DeployerOptions,
    protected readonly recoverVerificationInputs = false,
  ) {
    this.logger = options?.logger ?? debug('hyperlane:deployer');
    this.chainTimeoutMs = options?.chainTimeoutMs ?? 5 * 60 * 1000; // 5 minute timeout per chain
  }

  cacheAddressesMap(addressesMap: HyperlaneAddressesMap<any>): void {
    this.cachedAddresses = addressesMap;
  }

  async checkConfig(_: ChainMap<Config>): Promise<void> {
    return;
  }

  abstract deployContracts(
    chain: ChainName,
    config: Config,
  ): Promise<HyperlaneContracts<Factories>>;

  async deploy(
    configMap: ChainMap<Config>,
  ): Promise<HyperlaneContractsMap<Factories>> {
    const configChains = Object.keys(configMap);
    const ethereumConfigChains = configChains.filter(
      (chain) =>
        this.multiProvider.getChainMetadata(chain).protocol ===
        ProtocolType.Ethereum,
    );

    const targetChains = this.multiProvider.intersect(
      ethereumConfigChains,
      true,
    ).intersection;

    this.logger(`Start deploy to ${targetChains}`);
    for (const chain of targetChains) {
      const signerUrl = await this.multiProvider.tryGetExplorerAddressUrl(
        chain,
      );
      const signerAddress = await this.multiProvider.getSignerAddress(chain);
      const fromString = signerUrl || signerAddress;
      this.logger(`Deploying to ${chain} from ${fromString}`);
      this.startingBlockNumbers[chain] = await this.multiProvider
        .getProvider(chain)
        .getBlockNumber();
      await runWithTimeout(this.chainTimeoutMs, async () => {
        const contracts = await this.deployContracts(chain, configMap[chain]);
        this.addDeployedContracts(chain, contracts);
      });
    }
    return this.deployedContracts;
  }

  protected addDeployedContracts(
    chain: ChainName,
    contracts: HyperlaneContracts<any>,
    verificationInputs?: ContractVerificationInput[],
  ): void {
    this.deployedContracts[chain] = {
      ...this.deployedContracts[chain],
      ...contracts,
    };
    if (verificationInputs)
      this.addVerificationArtifacts(chain, verificationInputs);
  }

  protected addVerificationArtifacts(
    chain: ChainName,
    artifacts: ContractVerificationInput[],
  ): void {
    this.verificationInputs[chain] = this.verificationInputs[chain] || [];
    artifacts.forEach((artifact) => {
      this.verificationInputs[chain].push(artifact);
    });

    // TODO: deduplicate
  }

  protected async runIf<T>(
    chain: ChainName,
    address: string,
    fn: () => Promise<T>,
    label = 'address',
  ): Promise<T | undefined> {
    const signer = await this.multiProvider.getSignerAddress(chain);
    if (eqAddress(address, signer)) {
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

  protected async configureIsm<C extends Ownable>(
    chain: ChainName,
    contract: C,
    config: IsmConfig,
    getIsm: (contract: C) => Promise<Address>,
    setIsm: (contract: C, ism: Address) => Promise<PopulatedTransaction>,
  ): Promise<void> {
    if (this.options?.ismFactory === undefined) {
      throw new Error('No ISM factory provided');
    }
    const ismFactory = this.options.ismFactory;

    const configuredIsm = await getIsm(contract);
    const matches = await moduleMatchesConfig(
      chain,
      configuredIsm,
      config,
      this.multiProvider,
      ismFactory.getContracts(chain),
    );
    if (!matches) {
      await this.runIfOwner(chain, contract, async () => {
        const targetIsm = await ismFactory.deploy(chain, config);
        this.logger(`Set ISM on ${chain}`);
        await this.multiProvider.sendTransaction(
          chain,
          setIsm(contract, targetIsm.address),
        );
        if (targetIsm.address !== (await getIsm(contract))) {
          throw new Error(`Set ISM failed on ${chain}`);
        }
      });
    }
  }

  protected async configureHook<C extends Ownable>(
    chain: ChainName,
    contract: C,
    targetHook: Address,
    getHook: (contract: C) => Promise<Address>,
    setHook: (contract: C, hook: Address) => Promise<PopulatedTransaction>,
  ): Promise<void> {
    const configuredHook = await getHook(contract);
    if (targetHook !== configuredHook) {
      await this.runIfOwner(chain, contract, async () => {
        this.logger(`Set hook on ${chain}`);
        await this.multiProvider.sendTransaction(
          chain,
          setHook(contract, targetHook),
        );
        if (targetHook !== (await getHook(contract))) {
          throw new Error(`Set hook failed on ${chain}`);
        }
      });
    }
  }

  protected async initMailboxClient(
    local: ChainName,
    client: MailboxClient,
    config: MailboxClientConfig,
  ): Promise<void> {
    this.logger(`Initializing mailbox client (if not already) on ${local}...`);
    if (config.hook) {
      await this.configureHook(
        local,
        client,
        config.hook,
        (_client) => _client.hook(),
        (_client, _hook) => _client.populateTransaction.setHook(_hook),
      );
    }

    if (config.interchainSecurityModule) {
      await this.configureIsm(
        local,
        client,
        config.interchainSecurityModule,
        (_client) => _client.interchainSecurityModule(),
        (_client, _module) =>
          _client.populateTransaction.setInterchainSecurityModule(_module),
      );
    }

    this.logger(`Connection client on ${local} initialized...`);
  }

  protected async deployContractFromFactory<F extends ethers.ContractFactory>(
    chain: ChainName,
    factory: F,
    contractName: string,
    constructorArgs: Parameters<F['deploy']>,
    initializeArgs?: Parameters<Awaited<ReturnType<F['deploy']>>['initialize']>,
  ): Promise<ReturnType<F['deploy']>> {
    const cachedContract = this.readCache(chain, factory, contractName);
    if (cachedContract) {
      if (this.recoverVerificationInputs) {
        const recoveredInputs = await this.recoverVerificationArtifacts(
          chain,
          contractName,
          cachedContract,
          constructorArgs,
          initializeArgs,
        );
        this.addVerificationArtifacts(chain, recoveredInputs);
      }
      return cachedContract;
    }

    this.logger(`Deploy ${contractName} on ${chain}`);
    const contract = await this.multiProvider.handleDeploy(
      chain,
      factory,
      constructorArgs,
    );

    if (initializeArgs) {
      this.logger(`Initialize ${contractName} on ${chain}`);
      const overrides = this.multiProvider.getTransactionOverrides(chain);
      const initTx = await contract.initialize(...initializeArgs, overrides);
      await this.multiProvider.handleTx(chain, initTx);
    }

    const verificationInput = getContractVerificationInput(
      contractName,
      contract,
      factory.bytecode,
    );
    this.addVerificationArtifacts(chain, [verificationInput]);

    return contract;
  }

  async deployContract<K extends keyof Factories>(
    chain: ChainName,
    contractName: K,
    constructorArgs: Parameters<Factories[K]['deploy']>,
    initializeArgs?: Parameters<
      Awaited<ReturnType<Factories[K]['deploy']>>['initialize']
    >,
  ): Promise<HyperlaneContracts<Factories>[K]> {
    const contract = await this.deployContractFromFactory(
      chain,
      this.factories[contractName],
      contractName.toString(),
      constructorArgs,
      initializeArgs,
    );
    this.writeCache(chain, contractName, contract.address);
    return contract;
  }

  protected async changeAdmin(
    chain: ChainName,
    proxy: TransparentUpgradeableProxy,
    admin: string,
  ): Promise<void> {
    const actualAdmin = await proxyAdmin(
      this.multiProvider.getProvider(chain),
      proxy.address,
    );
    if (eqAddress(admin, actualAdmin)) {
      this.logger(`Admin set correctly, skipping admin change`);
      return;
    }

    const txOverrides = this.multiProvider.getTransactionOverrides(chain);
    this.logger(`Changing proxy admin`);
    await this.runIfAdmin(
      chain,
      proxy,
      () =>
        this.multiProvider.handleTx(
          chain,
          proxy.changeAdmin(admin, txOverrides),
        ),
      (proxyAdmin: ProxyAdmin) =>
        this.multiProvider.handleTx(
          chain,
          proxyAdmin.changeProxyAdmin(proxy.address, admin, txOverrides),
        ),
    );
  }

  protected async upgradeAndInitialize<C extends ethers.Contract>(
    chain: ChainName,
    proxy: TransparentUpgradeableProxy,
    implementation: C,
    initializeArgs: Parameters<C['initialize']>,
  ): Promise<void> {
    const current = await proxy.callStatic.implementation();
    if (eqAddress(implementation.address, current)) {
      this.logger(`Implementation set correctly, skipping upgrade`);
      return;
    }

    this.logger(`Upgrading and initializing implementation`);
    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initializeArgs,
    );
    const overrides = this.multiProvider.getTransactionOverrides(chain);
    await this.runIfAdmin(
      chain,
      proxy,
      () =>
        this.multiProvider.handleTx(
          chain,
          proxy.upgradeToAndCall(implementation.address, initData, overrides),
        ),
      (proxyAdmin: ProxyAdmin) =>
        this.multiProvider.handleTx(
          chain,
          proxyAdmin.upgradeAndCall(
            proxy.address,
            implementation.address,
            initData,
            overrides,
          ),
        ),
    );
  }

  protected async deployProxy<C extends ethers.Contract>(
    chain: ChainName,
    implementation: C,
    proxyAdmin: string,
    initializeArgs?: Parameters<C['initialize']>,
  ): Promise<C> {
    const isProxied = await isProxy(
      this.multiProvider.getProvider(chain),
      implementation.address,
    );
    if (isProxied) {
      // if the implementation is already a proxy, do not deploy a new proxy
      return implementation;
    }

    const constructorArgs = proxyConstructorArgs(
      implementation,
      proxyAdmin,
      initializeArgs,
    );
    const proxy = await this.deployContractFromFactory(
      chain,
      new TransparentUpgradeableProxy__factory(),
      'TransparentUpgradeableProxy',
      constructorArgs,
    );

    return implementation.attach(proxy.address) as C;
  }

  async deployTimelock(
    chain: ChainName,
    timelockConfig: UpgradeConfig['timelock'],
  ): Promise<TimelockController> {
    return this.multiProvider.handleDeploy(
      chain,
      new TimelockController__factory(),
      // delay, [proposers], [executors], admin
      [
        timelockConfig.delay,
        [timelockConfig.roles.proposer],
        [timelockConfig.roles.executor],
        ethers.constants.AddressZero,
      ],
    );
  }

  writeCache<K extends keyof Factories>(
    chain: ChainName,
    contractName: K,
    address: Address,
  ): void {
    if (!this.cachedAddresses[chain]) {
      this.cachedAddresses[chain] = {};
    }
    this.cachedAddresses[chain][contractName] = address;
  }

  readCache<F extends ethers.ContractFactory>(
    chain: ChainName,
    factory: F,
    contractName: string,
  ): Awaited<ReturnType<F['deploy']>> | undefined {
    const cachedAddress = this.cachedAddresses[chain]?.[contractName];
    const hit =
      !!cachedAddress && cachedAddress !== ethers.constants.AddressZero;
    const contractAddress = hit ? cachedAddress : ethers.constants.AddressZero;
    const contract = factory
      .attach(contractAddress)
      .connect(this.multiProvider.getSignerOrProvider(chain)) as Awaited<
      ReturnType<F['deploy']>
    >;
    if (hit) {
      this.logger(
        `Recovered ${contractName.toString()} on ${chain} ${cachedAddress}`,
      );
      return contract;
    }
    return undefined;
  }

  async recoverVerificationArtifacts<C extends ethers.Contract>(
    chain: ChainName,
    contractName: string,
    cachedContract: C,
    constructorArgs: Parameters<C['deploy']>,
    initializeArgs?: Parameters<C['initialize']>,
  ): Promise<ContractVerificationInput[]> {
    const provider = this.multiProvider.getProvider(chain);
    const isProxied = await isProxy(provider, cachedContract.address);

    let implementation: string;
    if (isProxied) {
      implementation = await proxyImplementation(
        provider,
        cachedContract.address,
      );
    } else {
      implementation = cachedContract.address;
    }

    const implementationInput = buildVerificationInput(
      contractName,
      implementation,
      cachedContract.interface.encodeDeploy(constructorArgs),
    );

    if (!isProxied) {
      return [implementationInput];
    }

    const admin = await proxyAdmin(provider, cachedContract.address);
    const proxyArgs = proxyConstructorArgs(
      cachedContract.attach(implementation),
      admin,
      initializeArgs,
    );
    const proxyInput = buildVerificationInput(
      'TransparentUpgradeableProxy',
      cachedContract.address,
      TransparentUpgradeableProxy__factory.createInterface().encodeDeploy(
        proxyArgs,
      ),
    );
    return [implementationInput, proxyInput];
  }

  /**
   * Deploys the Implementation and Proxy for a given contract
   *
   */
  async deployProxiedContract<K extends keyof Factories>(
    chain: ChainName,
    contractName: K,
    proxyAdmin: string,
    constructorArgs: Parameters<Factories[K]['deploy']>,
    initializeArgs?: Parameters<HyperlaneContracts<Factories>[K]['initialize']>,
  ): Promise<HyperlaneContracts<Factories>[K]> {
    // Try to initialize the implementation even though it may not be necessary
    const implementation = await this.deployContract(
      chain,
      contractName,
      constructorArgs,
      initializeArgs,
    );

    // Initialize the proxy the same way
    const contract = await this.deployProxy(
      chain,
      implementation,
      proxyAdmin,
      initializeArgs,
    );
    this.writeCache(chain, contractName, contract.address);
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
    owner: Address,
    ownables: { [key: string]: Ownable },
  ): Promise<ethers.ContractReceipt[]> {
    const receipts: ethers.ContractReceipt[] = [];
    for (const contractName of Object.keys(ownables)) {
      const ownable = ownables[contractName];
      const currentOwner = await ownable.owner();
      if (!eqAddress(currentOwner, owner)) {
        this.logger(
          `Transferring ownership of ${contractName} to ${owner} on ${chain}`,
        );
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
