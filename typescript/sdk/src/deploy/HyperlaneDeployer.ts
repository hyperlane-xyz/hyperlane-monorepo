import { Debugger, debug } from 'debug';
import { ethers } from 'ethers';

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
  HyperlaneContract,
  HyperlaneContracts,
  HyperlaneFactories,
  connectContractsMap,
  serializeContracts,
} from '../contracts';
import { MultiProvider } from '../providers/MultiProvider';
import {
  ProxiedContract,
  ProxyKind,
  TransparentProxyAddresses,
} from '../proxy';
import { ConnectionClientConfig } from '../router/types';
import { ChainMap, ChainName } from '../types';
import { objMap } from '../utils/objects';

import { ContractVerificationInput } from './verify/types';
import {
  buildVerificationInput,
  getContractVerificationInput,
} from './verify/utils';

export interface DeployerOptions {
  logger?: Debugger;
}

export interface DeployOptions {
  create2Salt?: string;
  initCalldata?: string;
  proxyAdmin?: string;
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
    public readonly configMap: ChainMap<Config>,
    public readonly factories: Factories,
    protected readonly options?: DeployerOptions,
  ) {
    this.verificationInputs = objMap(configMap, () => []);
    this.logger = options?.logger || debug('hyperlane:AppDeployer');
  }

  cacheContracts(partialDeployment: ChainMap<Contracts>): void {
    this.deployedContracts = connectContractsMap(
      partialDeployment,
      this.multiProvider,
    );
  }

  abstract deployContracts(
    chain: ChainName,
    config: Config,
  ): Promise<Contracts>;

  async deploy(
    partialDeployment?: ChainMap<Contracts>,
  ): Promise<ChainMap<Contracts>> {
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
    proxy: TransparentUpgradeableProxy,
    signerAdminFn: () => Promise<T>,
    proxyAdminOwnerFn: (proxyAdmin: ProxyAdmin) => Promise<T>,
  ): Promise<T | undefined> {
    const admin = await proxy.callStatic.admin();
    const code = await this.multiProvider.getProvider(chain).getCode(admin);
    if (code !== '0x') {
      const proxyAdmin = ProxyAdmin__factory.connect(admin, proxy.signer);
      return this.runIfOwner(chain, proxyAdmin, () =>
        proxyAdminOwnerFn(proxyAdmin),
      );
    } else {
      return this.runIf(chain, admin, signerAdminFn);
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
    if (cachedContract && !(cachedContract instanceof ProxiedContract)) {
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

  protected async changeAdmin(
    chain: ChainName,
    proxy: TransparentUpgradeableProxy,
    admin: string,
  ): Promise<void> {
    this.logger(`Changing proxy admin`);
    await this.runIfAdmin(
      chain,
      proxy,
      () => proxy.changeAdmin(admin),
      (proxyAdmin) => proxyAdmin.changeProxyAdmin(proxy.address, admin),
    );
  }

  protected async upgradeAndInitialize(
    chain: ChainName,
    proxy: TransparentUpgradeableProxy,
    implementation: string,
    initData: string,
  ): Promise<void> {
    this.logger(`Upgrading and initializing implementation`);
    await this.runIfAdmin(
      chain,
      proxy,
      () => proxy.upgradeToAndCall(implementation, initData),
      (proxyAdmin) =>
        proxyAdmin.upgradeAndCall(proxy.address, implementation, initData),
    );
  }

  protected async deployProxy<C extends ethers.Contract>(
    chain: ChainName,
    implementation: C,
    initArgs: Parameters<C['initialize']>,
    deployOpts?: DeployOptions,
    initialize = true,
  ): Promise<ProxiedContract<C, TransparentProxyAddresses>> {
    const deployer = await this.multiProvider.getSignerAddress(chain);
    const provider = this.multiProvider.getProvider(chain);

    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );

    const proxyDeployer = async (
      implementationAddress: string,
      initCallData: string,
    ) =>
      await this.deployContractFromFactory(
        chain,
        new TransparentUpgradeableProxy__factory(),
        'TransparentUpgradeableProxy',
        [implementationAddress, deployer, initCallData],
        deployOpts,
      );

    const useCreate2 =
      deployOpts?.create2Salt !== undefined &&
      (await provider.getCode(CREATE2FACTORY_ADDRESS)) !== '0x';

    this.logger(`Deploying transparent upgradable proxy`);
    let proxy: TransparentUpgradeableProxy;
    if (useCreate2) {
      // deploy with static implementation and init data for consistent addresses
      proxy = await proxyDeployer(CREATE2FACTORY_ADDRESS, '0x');
      // hack for skipping upgrade and initialize for dummy implementations
      if (initialize) {
        // upgrade and initialize with actual implementation and init data
        await this.upgradeAndInitialize(
          chain,
          proxy,
          implementation.address,
          initData,
        );
      }
    } else {
      proxy = await proxyDeployer(implementation.address, initData);
    }

    if (deployOpts?.proxyAdmin) {
      await this.changeAdmin(chain, proxy, deployOpts.proxyAdmin);
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
        `Recovered ${contractName.toString()} on ${chain} proxy=${
          cachedProxy.addresses.proxy
        } implementation=${cachedProxy.addresses.implementation}`,
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
        `Recovered ${contractName.toString()} on ${chain} proxy=${
          cachedProxy.addresses.proxy
        }`,
      );

      cachedProxy.addresses.implementation = implementation.address;
      this.cacheContract(chain, contractName, cachedProxy);
      return cachedProxy as ProxiedContract<C, TransparentProxyAddresses>;
    }

    const contract = await this.deployProxy(
      chain,
      implementation as C,
      initArgs,
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
