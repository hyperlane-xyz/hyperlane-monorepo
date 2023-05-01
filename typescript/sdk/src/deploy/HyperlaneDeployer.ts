import { Debugger, debug } from 'debug';
import { Contract, ethers } from 'ethers';

import {
  HyperlaneConnectionClient,
  Ownable,
  ProxyAdmin,
  ProxyAdmin__factory,
  TransparentUpgradeableProxy,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';
import { types, utils } from '@hyperlane-xyz/utils';

import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
} from '../contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { ConnectionClientConfig } from '../router/types';
import { ChainMap, ChainName } from '../types';

import { proxyAdmin } from './proxy';
import { ContractVerificationInput } from './verify/types';
import { getContractVerificationInput } from './verify/utils';

export interface DeployerOptions {
  logger?: Debugger;
  chainTimeoutMs?: number;
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
  ) {
    this.logger = options?.logger ?? debug('hyperlane:deployer');
    this.chainTimeoutMs = options?.chainTimeoutMs ?? 5 * 60 * 1000; // 5 minute timeout per chain
  }

  cacheAddressesMap(addressesMap: HyperlaneAddressesMap<any>): void {
    this.cachedAddresses = addressesMap;
  }

  /* eslint-disable-next-line no-empty-console */
  async checkConfig(configMap: ChainMap<Config>): Promise<void> {}

  abstract deployContracts(
    chain: ChainName,
    config: Config,
  ): Promise<HyperlaneContracts<Factories>>;

  async deploy(
    configMap: ChainMap<Config>,
  ): Promise<HyperlaneContractsMap<Factories>> {
    await this.checkConfig(configMap);
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
      const signerAddress = await this.multiProvider.getSignerAddress(chain);
      const fromString = signerUrl || signerAddress;
      this.logger(`Deploying to ${chain} from ${fromString}`);
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
    await this.runIfOwner(local, connectionClient, async () => {
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
      return cachedContract;
    }

    const signer = this.multiProvider.getSigner(chain);
    const overrides = this.multiProvider.getTransactionOverrides(chain);

    this.logger(`Deploy ${contractName} on ${chain}`);
    const contract = await (factory
      .connect(signer)
      .deploy(...constructorArgs, overrides) as ReturnType<F['deploy']>);

    await this.multiProvider.handleTx(chain, contract.deployTransaction);

    if (initializeArgs) {
      this.logger(`Initialize ${contractName} on ${chain}`);
      const initTx = await contract.initialize(...initializeArgs);
      await this.multiProvider.handleTx(chain, initTx);
    }

    const verificationInput = getContractVerificationInput(
      contractName,
      contract,
      factory.bytecode,
    );
    this.verificationInputs[chain] = this.verificationInputs[chain] || [];
    this.verificationInputs[chain].push(verificationInput);

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
    const contract = (await this.deployContractFromFactory(
      chain,
      this.factories[contractName],
      contractName.toString(),
      constructorArgs,
      initializeArgs,
    )) as HyperlaneContracts<Factories>[K];
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
    if (utils.eqAddress(admin, actualAdmin)) {
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

  protected async upgradeAndInitialize<C extends ethers.Contract>(
    chain: ChainName,
    proxy: TransparentUpgradeableProxy,
    implementation: C,
    initializeArgs: Parameters<C['initialize']>,
  ): Promise<void> {
    const current = await proxy.callStatic.implementation();
    if (utils.eqAddress(implementation.address, current)) {
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
    const initData = initializeArgs
      ? implementation.interface.encodeFunctionData(
          'initialize',
          initializeArgs,
        )
      : '0x';

    this.logger(`Deploying transparent upgradable proxy`);
    const constructorArgs: [string, string, string] = [
      implementation.address,
      proxyAdmin,
      initData,
    ];
    const proxy = await this.deployContractFromFactory(
      chain,
      new TransparentUpgradeableProxy__factory(),
      'TransparentUpgradeableProxy',
      constructorArgs,
    );

    return implementation.attach(proxy.address) as C;
  }

  protected writeCache<K extends keyof Factories>(
    chain: ChainName,
    contractName: K,
    address: types.Address,
  ): void {
    if (!this.cachedAddresses[chain]) {
      this.cachedAddresses[chain] = {};
    }
    this.cachedAddresses[chain][contractName] = address;
  }

  protected readCache<F extends ethers.ContractFactory>(
    chain: ChainName,
    factory: F,
    contractName: string,
  ): Awaited<ReturnType<F['deploy']>> | undefined {
    const cachedAddress = this.cachedAddresses[chain]?.[contractName];
    const hit = !!cachedAddress;
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
    const cachedContract = this.readCache(
      chain,
      this.factories[contractName],
      contractName.toString(),
    );
    if (cachedContract) {
      return cachedContract;
    }

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
    owner: types.Address,
    ownables: { [key: string]: Ownable },
  ): Promise<ethers.ContractReceipt[]> {
    const receipts: ethers.ContractReceipt[] = [];
    for (const contractName of Object.keys(ownables)) {
      const ownable = ownables[contractName];
      const currentOwner = await ownable.owner();
      if (!utils.eqAddress(currentOwner, owner)) {
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
