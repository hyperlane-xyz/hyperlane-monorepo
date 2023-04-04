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
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
  connectContractsMap,
  serializeContracts,
} from '../contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { ConnectionClientConfig } from '../router/types';
import { ChainMap, ChainName } from '../types';
import { objMap } from '../utils/objects';

import { proxyAdmin } from './proxy';
import { ContractVerificationInput } from './verify/types';
import { getContractVerificationInput } from './verify/utils';

export interface DeployerOptions {
  logger?: Debugger;
}

export abstract class HyperlaneDeployer<
  Config,
  Factories extends HyperlaneFactories,
> {
  public deployedContracts: HyperlaneContractsMap<Factories> = {};
  public verificationInputs: ChainMap<ContractVerificationInput[]>;
  protected logger: Debugger;

  constructor(
    protected readonly multiProvider: MultiProvider,
    public readonly configMap: ChainMap<Config>,
    public readonly factories: Factories,
    protected readonly options?: DeployerOptions,
  ) {
    this.verificationInputs = objMap(configMap, () => []);
    this.logger = options?.logger || debug('hyperlane:AppDeployer');
  }

  cacheContracts(partialDeployment: HyperlaneContractsMap<Factories>): void {
    this.deployedContracts = connectContractsMap(
      partialDeployment,
      this.multiProvider,
    );
  }

  abstract deployContracts(
    chain: ChainName,
    config: Config,
  ): Promise<HyperlaneContracts<Factories>>;

  async deploy(
    partialDeployment?: HyperlaneContractsMap<Factories>,
  ): Promise<HyperlaneContractsMap<Factories>> {
    if (partialDeployment) {
      this.cacheContracts(partialDeployment);
    }

    const configChains = Object.keys(this.configMap);
    const targetChains = this.multiProvider.intersect(
      configChains,
      true,
    ).intersection;

    this.logger(`Start deploy to ${targetChains}`);
    for (const chain of targetChains) {
      const signerUrl = await this.multiProvider.tryGetExplorerAddressUrl(
        chain,
      );
      this.logger(`Deploying to ${chain} from ${signerUrl} ...`);
      this.deployedContracts[chain] = await this.deployContracts(
        chain,
        this.configMap[chain],
      );
      // TODO: remove these logs once we have better timeouts
      this.logger(
        JSON.stringify(
          serializeContracts(this.deployedContracts[chain] ?? {}),
          null,
          2,
        ),
      );
    }
    return this.deployedContracts;
  }

  protected async runIf<T>(
    chain: ChainName,
    address: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    const signer = await this.multiProvider.getSignerAddress(chain);
    if (address === signer) {
      return fn();
    } else {
      this.logger(`Signer (${signer}) does not match address (${address})`);
    }
    return undefined;
  }

  protected async runIfOwner<T>(
    chain: ChainName,
    ownable: Ownable,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    return this.runIf(chain, await ownable.callStatic.owner(), fn);
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
      return this.runIf(chain, admin, () => signerAdminFn());
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
    initializeArgs?: Parameters<Awaited<ReturnType<F['deploy']>>['initialize']>,
  ): Promise<ReturnType<F['deploy']>> {
    const cachedContract = this.deployedContracts[chain]?.[contractName];
    if (cachedContract) {
      this.logger(
        `Recovered ${contractName} on ${chain} ${cachedContract.address}`,
      );
      return cachedContract as ReturnType<F['deploy']>;
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
    await this.runIfAdmin(
      chain,
      proxy,
      () =>
        this.multiProvider.handleTx(
          chain,
          proxy.upgradeToAndCall(implementation.address, initData),
        ),
      (proxyAdmin) =>
        this.multiProvider.handleTx(
          chain,
          proxyAdmin.upgradeAndCall(
            proxy.address,
            implementation.address,
            initData,
          ),
        ),
    );
  }

  protected async deployProxy<C extends ethers.Contract>(
    chain: ChainName,
    implementation: C,
    initializeArgs: Parameters<C['initialize']>,
    proxyAdmin: string,
  ): Promise<C> {
    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initializeArgs,
    );

    this.logger(`Deploying transparent upgradable proxy`);
    const constructorArgs: Parameters<
      TransparentUpgradeableProxy__factory['deploy']
    > = [implementation.address, proxyAdmin, initData];
    const proxy = await this.deployContractFromFactory(
      chain,
      new TransparentUpgradeableProxy__factory(),
      'TransparentUpgradeableProxy',
      constructorArgs,
    );

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
    initializeArgs: Parameters<HyperlaneContracts<Factories>[K]['initialize']>,
    proxyAdmin: string,
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

    // Initialize the implementation even though it may not be necessary
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
      initializeArgs,
      proxyAdmin,
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
