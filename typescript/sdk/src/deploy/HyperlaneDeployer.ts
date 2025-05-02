import { Contract, PopulatedTransaction, ethers } from 'ethers';
import { Logger } from 'pino';

import {
  ITransparentUpgradeableProxy,
  MailboxClient,
  Ownable,
  ProxyAdmin,
  ProxyAdmin__factory,
  TimelockController,
  TimelockController__factory,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  Address,
  ProtocolType,
  addBufferToGasLimit,
  eqAddress,
  isZeroishAddress,
  rootLogger,
  runWithTimeout,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
} from '../contracts/types.js';
import { HookConfig } from '../hook/types.js';
import type { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { IsmConfig } from '../ism/types.js';
import { moduleMatchesConfig } from '../ism/utils.js';
import {
  ChainTechnicalStack,
  ExplorerFamily,
} from '../metadata/chainMetadataTypes.js';
import { InterchainAccount } from '../middleware/account/InterchainAccount.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { MailboxClientConfig } from '../router/types.js';
import { ChainMap, ChainName, OwnableConfig } from '../types.js';
import { getZKSyncArtifactByContractName } from '../utils/zksync.js';

import {
  UpgradeConfig,
  isInitialized,
  isProxy,
  proxyAdmin,
  proxyConstructorArgs,
  proxyImplementation,
} from './proxy.js';
import { ContractVerifier } from './verify/ContractVerifier.js';
import { ZKSyncContractVerifier } from './verify/ZKSyncContractVerifier.js';
import {
  ContractVerificationInput,
  ExplorerLicenseType,
} from './verify/types.js';
import {
  buildVerificationInput,
  getContractVerificationInput,
  getContractVerificationInputForZKSync,
  shouldAddVerificationInput,
} from './verify/utils.js';

export interface DeployerOptions {
  logger?: Logger;
  chainTimeoutMs?: number;
  ismFactory?: HyperlaneIsmFactory;
  icaApp?: InterchainAccount;
  contractVerifier?: ContractVerifier;
  concurrentDeploy?: boolean;
}

export abstract class HyperlaneDeployer<
  Config,
  Factories extends HyperlaneFactories,
> {
  public verificationInputs: ChainMap<ContractVerificationInput[]> = {};
  public cachedAddresses: HyperlaneAddressesMap<any> = {};
  public deployedContracts: HyperlaneContractsMap<Factories> = {};

  protected cachingEnabled = true;

  protected logger: Logger;
  chainTimeoutMs: number;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly factories: Factories,
    protected readonly options: DeployerOptions = {},
    protected readonly recoverVerificationInputs = false,
    protected readonly icaAddresses = {},
  ) {
    this.logger = options?.logger ?? rootLogger.child({ module: 'deployer' });
    this.chainTimeoutMs = options?.chainTimeoutMs ?? 15 * 60 * 1000; // 15 minute timeout per chain
    if (Object.keys(icaAddresses).length > 0) {
      this.options.icaApp = InterchainAccount.fromAddressesMap(
        icaAddresses,
        multiProvider,
      );
    }

    // if none provided, instantiate a default verifier with the default core contract build artifact
    this.options.contractVerifier ??= new ContractVerifier(
      multiProvider,
      {},
      coreBuildArtifact,
      ExplorerLicenseType.MIT,
    );
  }

  cacheAddressesMap(addressesMap: HyperlaneAddressesMap<any>): void {
    this.cachedAddresses = addressesMap;
  }

  async verifyContract(
    chain: ChainName,
    input: ContractVerificationInput,
    logger = this.logger,
  ): Promise<void> {
    return this.options.contractVerifier?.verifyContract(chain, input, logger);
  }

  async verifyContractForZKSync(
    chain: ChainName,
    input: ContractVerificationInput,
    logger = this.logger,
  ): Promise<void> {
    const verifier = new ZKSyncContractVerifier(this.multiProvider);
    return verifier.verifyContract(chain, input, logger);
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

    this.logger.debug(`Start deploy to ${targetChains}`);

    const failedChains: ChainName[] = [];
    const deployChain = async (chain: ChainName) => {
      const signerUrl =
        await this.multiProvider.tryGetExplorerAddressUrl(chain);
      const signerAddress = await this.multiProvider.getSignerAddress(chain);
      const fromString = signerUrl || signerAddress;
      this.logger.info(`Deploying to ${chain} from ${fromString}`);

      return runWithTimeout(this.chainTimeoutMs, async () => {
        const contracts = await this.deployContracts(chain, configMap[chain]);
        this.addDeployedContracts(chain, contracts);
      })
        .then(() => {
          this.logger.info(`Successfully deployed contracts on ${chain}`);
        })
        .catch((error) => {
          failedChains.push(chain);
          this.logger.error(`Deployment failed on ${chain}. Error: ${error}`);
          throw error;
        });
    };

    if (this.options.concurrentDeploy) {
      await Promise.allSettled(targetChains.map(deployChain));
    } else {
      for (const chain of targetChains) {
        await deployChain(chain);
      }
    }

    if (failedChains.length > 0) {
      throw new Error(
        `Deployment failed on chains: ${failedChains.join(', ')}`,
      );
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
      if (
        shouldAddVerificationInput(this.verificationInputs, chain, artifact)
      ) {
        this.verificationInputs[chain].push(artifact);
      }
    });
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
      this.logger.debug(
        `Signer (${signer}) does not match ${label} (${address})`,
      );
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
      this.logger.debug(`Admin is a ProxyAdmin (${admin})`);
      const proxyAdmin = ProxyAdmin__factory.connect(admin, proxy.signer);
      return this.runIfOwner(chain, proxyAdmin, () =>
        proxyAdminOwnerFn(proxyAdmin),
      );
    } else {
      this.logger.debug(`Admin is an EOA (${admin})`);
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
    const configuredIsm = await getIsm(contract);
    let matches = false;
    let targetIsm: Address;
    if (typeof config === 'string') {
      if (eqAddress(configuredIsm, config)) {
        matches = true;
      } else {
        targetIsm = config;
      }
    } else {
      const ismFactory =
        this.options.ismFactory ??
        (() => {
          throw new Error('No ISM factory provided');
        })();

      matches = await moduleMatchesConfig(
        chain,
        configuredIsm,
        config,
        this.multiProvider,
        ismFactory.getContracts(chain),
      );
      targetIsm = (await ismFactory.deploy({ destination: chain, config }))
        .address;
    }
    if (!matches) {
      await this.runIfOwner(chain, contract, async () => {
        this.logger.debug(`Set ISM on ${chain} with address ${targetIsm}`);
        const populatedTx = await setIsm(contract, targetIsm);
        const estimatedGas = await this.multiProvider
          .getSigner(chain)
          .estimateGas(populatedTx);
        populatedTx.gasLimit = addBufferToGasLimit(estimatedGas);
        await this.multiProvider.sendTransaction(chain, populatedTx);

        if (!eqAddress(targetIsm, await getIsm(contract))) {
          throw new Error(`Set ISM failed on ${chain}`);
        }
      });
    }
  }

  protected async configureHook<C extends Ownable>(
    chain: ChainName,
    contract: C,
    config: HookConfig,
    getHook: (contract: C) => Promise<Address>,
    setHook: (contract: C, hook: Address) => Promise<PopulatedTransaction>,
  ): Promise<void> {
    if (typeof config !== 'string') {
      throw new Error('Legacy deployer does not support hook objects');
    }

    const configuredHook = await getHook(contract);
    if (!eqAddress(config, configuredHook)) {
      await this.runIfOwner(chain, contract, async () => {
        this.logger.debug(
          `Set hook on ${chain} to ${config}, currently is ${configuredHook}`,
        );
        await this.multiProvider.sendTransaction(
          chain,
          setHook(contract, config),
        );
        const actualHook = await getHook(contract);
        if (!eqAddress(config, actualHook)) {
          throw new Error(
            `Set hook failed on ${chain}, wanted ${config}, got ${actualHook}`,
          );
        }
      });
    }
  }

  protected async configureClient(
    local: ChainName,
    client: MailboxClient,
    config: MailboxClientConfig,
  ): Promise<void> {
    this.logger.debug(
      `Initializing mailbox client (if not already) on ${local}...`,
    );
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

    this.logger.debug(`Mailbox client on ${local} initialized...`);
  }

  public async deployContractFromFactory<F extends ethers.ContractFactory>(
    chain: ChainName,
    factory: F,
    contractName: string,
    constructorArgs: Parameters<F['deploy']>,
    initializeArgs?: Parameters<Awaited<ReturnType<F['deploy']>>['initialize']>,
    shouldRecover = true,
    implementationAddress?: Address,
  ): Promise<ReturnType<F['deploy']>> {
    if (this.cachingEnabled && shouldRecover) {
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
    }

    this.logger.info(
      `Deploying ${contractName} on ${chain} with constructor args (${constructorArgs.join(
        ', ',
      )})...`,
    );

    const explorer = this.multiProvider.tryGetExplorerApi(chain);
    const { technicalStack } = this.multiProvider.getChainMetadata(chain);
    const isZKSyncExplorer = explorer?.family === ExplorerFamily.ZkSync;
    const isZKSyncChain = technicalStack === ChainTechnicalStack.ZkSync;
    const signer = this.multiProvider.getSigner(chain);
    const artifact = await getZKSyncArtifactByContractName(contractName);

    const contract = await this.multiProvider.handleDeploy(
      chain,
      factory,
      constructorArgs,
      artifact,
    );

    if (initializeArgs) {
      if (
        await isInitialized(
          this.multiProvider.getProvider(chain),
          contract.address,
        )
      ) {
        this.logger.debug(
          `Skipping: Contract ${contractName} (${contract.address}) on ${chain} is already initialized`,
        );
      } else {
        this.logger.debug(
          `Initializing ${contractName} (${contract.address}) on ${chain}...`,
        );

        const overrides = this.multiProvider.getTransactionOverrides(chain);

        // Estimate gas for the initialize transaction
        const estimatedGas = await contract
          .connect(signer)
          .estimateGas.initialize(...initializeArgs);

        const initTx = await contract.initialize(...initializeArgs, {
          gasLimit: addBufferToGasLimit(estimatedGas),
          ...overrides,
        });
        this.logger.info(`Contract ${contractName} initialized`);
        const receipt = await this.multiProvider.handleTx(chain, initTx);
        this.logger.debug(
          `Successfully initialized ${contractName} (${contract.address}) on ${chain}: ${receipt.transactionHash}`,
        );
      }
    }

    let verificationInput: ContractVerificationInput;
    if (isZKSyncChain) {
      if (!artifact) {
        throw new Error(
          `No ZkSync artifact found for contract: ${contractName}`,
        );
      }
      verificationInput = await getContractVerificationInputForZKSync({
        name: contractName,
        contract,
        constructorArgs: constructorArgs,
        artifact: artifact,
        expectedimplementation: implementationAddress,
      });
    } else {
      verificationInput = getContractVerificationInput({
        name: contractName,
        contract,
        bytecode: factory.bytecode,
        expectedimplementation: implementationAddress,
      });
    }

    this.addVerificationArtifacts(chain, [verificationInput]);

    // try verifying contract
    try {
      await this[
        isZKSyncExplorer ? 'verifyContractForZKSync' : 'verifyContract'
      ](chain, verificationInput);
    } catch (error) {
      // log error but keep deploying, can also verify post-deployment if needed
      this.logger.debug(`Error verifying contract: ${error}`);
    }

    return contract;
  }

  /**
   * Deploys a contract with a specified name.
   *
   * This is a generic function capable of deploying any contract type, defined within the `Factories` type, to a specified chain.
   *
   * @param {ChainName} chain - The name of the chain on which the contract is to be deployed.
   * @param {K} contractKey - The key identifying the factory to use for deployment.
   * @param {string} contractName - The name of the contract to deploy. This must match the contract source code.
   * @param {Parameters<Factories[K]['deploy']>} constructorArgs - Arguments for the contract's constructor.
   * @param {Parameters<Awaited<ReturnType<Factories[K]['deploy']>>['initialize']>?} initializeArgs - Optional arguments for the contract's initialization function.
   * @param {boolean} shouldRecover - Flag indicating whether to attempt recovery if deployment fails.
   * @returns {Promise<HyperlaneContracts<Factories>[K]>} A promise that resolves to the deployed contract instance.
   */
  async deployContractWithName<K extends keyof Factories>(
    chain: ChainName,
    contractKey: K,
    contractName: string,
    constructorArgs: Parameters<Factories[K]['deploy']>,
    initializeArgs?: Parameters<
      Awaited<ReturnType<Factories[K]['deploy']>>['initialize']
    >,
    shouldRecover = true,
  ): Promise<HyperlaneContracts<Factories>[K]> {
    const contract = await this.deployContractFromFactory(
      chain,
      this.factories[contractKey],
      contractName,
      constructorArgs,
      initializeArgs,
      shouldRecover,
    );
    this.writeCache(chain, contractName, contract.address);
    return contract;
  }

  async deployContract<K extends keyof Factories>(
    chain: ChainName,
    contractKey: K,
    constructorArgs: Parameters<Factories[K]['deploy']>,
    initializeArgs?: Parameters<
      Awaited<ReturnType<Factories[K]['deploy']>>['initialize']
    >,
    shouldRecover = true,
  ): Promise<HyperlaneContracts<Factories>[K]> {
    return this.deployContractWithName(
      chain,
      contractKey,
      contractKey.toString(),
      constructorArgs,
      initializeArgs,
      shouldRecover,
    );
  }

  protected async changeAdmin(
    chain: ChainName,
    proxy: ITransparentUpgradeableProxy,
    admin: string,
  ): Promise<void> {
    const actualAdmin = await proxyAdmin(
      this.multiProvider.getProvider(chain),
      proxy.address,
    );
    if (eqAddress(admin, actualAdmin)) {
      this.logger.debug(`Admin set correctly, skipping admin change`);
      return;
    }

    const txOverrides = this.multiProvider.getTransactionOverrides(chain);
    this.logger.debug(`Changing proxy admin`);
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
    proxy: ITransparentUpgradeableProxy,
    implementation: C,
    initializeArgs: Parameters<C['initialize']>,
  ): Promise<void> {
    const current = await proxy.callStatic.implementation();
    if (eqAddress(implementation.address, current)) {
      this.logger.debug(`Implementation set correctly, skipping upgrade`);
      return;
    }

    this.logger.debug(`Upgrading and initializing implementation`);
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
      undefined,
      true,
      implementation.address,
    );

    return implementation.attach(proxy.address) as C;
  }

  async deployTimelock(
    chain: ChainName,
    timelockConfig: UpgradeConfig['timelock'],
  ): Promise<TimelockController> {
    const TimelockZkArtifact = await getZKSyncArtifactByContractName(
      'TimelockController',
    );
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
      TimelockZkArtifact,
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
    if (cachedAddress && !isZeroishAddress(cachedAddress)) {
      this.logger.debug(
        `Recovered ${contractName} on ${chain}: ${cachedAddress}`,
      );
      return factory
        .attach(cachedAddress)
        .connect(this.multiProvider.getSignerOrProvider(chain)) as Awaited<
        ReturnType<F['deploy']>
      >;
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
    contractKey: K,
    contractName: string,
    proxyAdmin: string,
    constructorArgs: Parameters<Factories[K]['deploy']>,
    initializeArgs?: Parameters<HyperlaneContracts<Factories>[K]['initialize']>,
  ): Promise<HyperlaneContracts<Factories>[K]> {
    // Try to initialize the implementation even though it may not be necessary
    const implementation = await this.deployContractWithName(
      chain,
      contractKey,
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

  async transferOwnershipOfContracts(
    chain: ChainName,
    config: OwnableConfig,
    ownables: Partial<Record<string, Ownable>>,
  ): Promise<ethers.ContractReceipt[]> {
    const receipts: ethers.ContractReceipt[] = [];
    for (const [contractName, ownable] of Object.entries<Ownable | undefined>(
      ownables,
    )) {
      if (!ownable) {
        continue;
      }
      const current = await ownable.owner();
      const owner = config.ownerOverrides?.[contractName] ?? config.owner;
      if (!eqAddress(current, owner)) {
        this.logger.debug(
          { contractName, current, desiredOwner: owner },
          'Current owner and config owner do not match',
        );
        const receipt = await this.runIfOwner(chain, ownable, async () => {
          this.logger.debug(
            `Transferring ownership of ${contractName} to ${owner} on ${chain}`,
          );
          const estimatedGas =
            await ownable.estimateGas.transferOwnership(owner);
          return this.multiProvider.handleTx(
            chain,
            ownable.transferOwnership(owner, {
              gasLimit: addBufferToGasLimit(estimatedGas),
              ...this.multiProvider.getTransactionOverrides(chain),
            }),
          );
        });
        if (receipt) receipts.push(receipt);
      }
    }

    return receipts.filter((x) => !!x) as ethers.ContractReceipt[];
  }
}
