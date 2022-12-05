import { Debugger, debug } from 'debug';
import { ethers } from 'ethers';

import {
  Create2Factory__factory,
  Ownable,
  UpgradeBeaconProxy__factory,
  UpgradeBeacon__factory,
} from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import {
  HyperlaneContract,
  HyperlaneContracts,
  HyperlaneFactories,
  connectContracts,
  serializeContracts,
} from '../contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { BeaconProxyAddresses, ProxiedContract, ProxyKind } from '../proxy';
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

  protected async runIfOwner(
    chain: Chain,
    ownable: Ownable,
    fn: () => Promise<any>,
  ): Promise<void> {
    const dc = this.multiProvider.getChainConnection(chain);
    const address = await dc.signer!.getAddress();
    const owner = await ownable.owner();
    this.logger({ owner });
    this.logger({ signer: address });
    if (address === owner) {
      return fn();
    }
  }

  protected async deployContractFromFactory<F extends ethers.ContractFactory>(
    chain: Chain,
    factory: F,
    contractName: string,
    args: Parameters<F['deploy']>,
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
      if (args.length > 0) {
        throw new Error("Can't use CREATE2 with deployment args");
      }
      this.logger(`Deploying with CREATE2 factory`);

      const create2Factory = Create2Factory__factory.connect(
        CREATE2FACTORY_ADDRESS,
        signer,
      );
      const salt = ethers.utils.keccak256(
        ethers.utils.hexlify(ethers.utils.toUtf8Bytes(deployOpts.create2Salt)),
      );
      const contractAddr = await create2Factory.deployedAddress(
        factory.bytecode,
        await signer.getAddress(),
        salt,
      );

      const deployTx = deployOpts.initCalldata
        ? await create2Factory.deployAndInit(
            factory.bytecode,
            salt,
            deployOpts.initCalldata,
            chainConnection.overrides,
          )
        : await create2Factory.deploy(
            factory.bytecode,
            salt,
            chainConnection.overrides,
          );
      await chainConnection.handleTx(deployTx);

      this.verificationInputs[chain].push({
        name: contractName,
        address: contractAddr,
        isProxy: false,
        constructorArguments: '',
      });

      return factory.attach(contractAddr).connect(signer) as ReturnType<
        F['deploy']
      >;
    } else {
      const contract = await factory
        .connect(signer)
        .deploy(...args, chainConnection.overrides);

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
    beaconAddress: string,
    initArgs: Parameters<C['initialize']>,
  ): Promise<ProxiedContract<C, BeaconProxyAddresses>> {
    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const deployArgs: Parameters<UpgradeBeaconProxy__factory['deploy']> = [
      beaconAddress,
      initData,
    ];
    const beaconProxy = await this.deployContractFromFactory(
      chain,
      new UpgradeBeaconProxy__factory(),
      'UpgradeBeaconProxy',
      deployArgs,
    );

    return new ProxiedContract<C, BeaconProxyAddresses>(
      implementation.attach(beaconProxy.address) as C,
      {
        kind: ProxyKind.UpgradeBeacon,
        proxy: beaconProxy.address,
        implementation: implementation.address,
        beacon: beaconAddress,
      },
    );
  }

  private cacheContract<K extends keyof Factories>(
    chain: Chain,
    contractName: K,
    contract: HyperlaneContract,
  ) {
    if (!this.deployedContracts[chain]) {
      [];
      this.deployedContracts[chain] = {};
    }
    if (this.deployedContracts[chain]) {
      // TODO: This doesn't compile but it *does* work.
      // Had to comment out to be able to push since prettier complains.
      // this.deployedContracts[chain]?.[contractName as string] = contract;
    }
  }

  /**
   * Deploys the UpgradeBeacon, Implementation and Proxy for a given contract
   *
   */
  async deployProxiedContract<
    K extends keyof Factories,
    C extends Awaited<ReturnType<Factories[K]['deploy']>>,
  >(
    chain: Chain,
    contractName: K,
    deployArgs: Parameters<Factories[K]['deploy']>,
    ubcAddress: types.Address,
    initArgs: Parameters<C['initialize']>,
  ): Promise<ProxiedContract<C, BeaconProxyAddresses>> {
    const cachedProxy = this.deployedContracts[chain]?.[contractName as any];
    if (cachedProxy) {
      this.logger(`Recovered proxy ${contractName.toString()} on ${chain}`);
      return cachedProxy as ProxiedContract<C, BeaconProxyAddresses>;
    }

    const implementation = await this.deployContract<K>(
      chain,
      contractName,
      deployArgs,
    );

    this.logger(`Proxy ${contractName.toString()} on ${chain}`);
    const beaconDeployArgs: Parameters<UpgradeBeacon__factory['deploy']> = [
      implementation.address,
      ubcAddress,
    ];
    const beacon = await this.deployContractFromFactory(
      chain,
      new UpgradeBeacon__factory(),
      'UpgradeBeacon',
      beaconDeployArgs,
    );
    const contract = await this.deployProxy(
      chain,
      implementation as C,
      beacon.address,
      initArgs,
    );
    this.cacheContract(chain, contractName, contract);
    return contract;
  }

  /**
   * Sets up a new proxy with the same beacon and implementation
   *
   */
  async duplicateProxiedContract<C extends ethers.Contract>(
    chain: Chain,
    proxy: ProxiedContract<C, BeaconProxyAddresses>,
    initArgs: Parameters<C['initialize']>,
  ): Promise<ProxiedContract<C, BeaconProxyAddresses>> {
    this.logger(`Duplicate Proxy on ${chain}`);
    return this.deployProxy(
      chain,
      proxy.contract.attach(proxy.addresses.implementation) as C,
      proxy.addresses.beacon,
      initArgs,
    );
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
