import { Debugger, debug } from 'debug';
import { ethers } from 'ethers';

import {
  Ownable,
  UpgradeBeaconProxy__factory,
  UpgradeBeacon__factory,
} from '@abacus-network/core';
import type { types } from '@abacus-network/utils';

import {
  AbacusContracts,
  AbacusFactories,
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

export abstract class AbacusDeployer<
  Chain extends ChainName,
  Config,
  Contracts extends AbacusContracts,
  Factories extends AbacusFactories,
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
    this.logger = options?.logger || debug('abacus:AppDeployer');
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
      this.logger(`Deploying to ${chain} from ${signerUrl}...`);
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
    if (address === owner) {
      return fn();
    }
  }

  protected async deployContractFromFactory<F extends ethers.ContractFactory>(
    chain: Chain,
    factory: F,
    contractName: string,
    args: Parameters<F['deploy']>,
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

    const contract = await factory
      .connect(signer)
      .deploy(...args, chainConnection.overrides);

    await chainConnection.handleTx(contract.deployTransaction);

    const verificationInput = getContractVerificationInput(
      contractName,
      contract,
      factory.bytecode,
    );
    this.verificationInputs[chain].push(verificationInput);
    return contract as ReturnType<F['deploy']>;
  }

  async deployContract<K extends keyof Factories>(
    chain: Chain,
    contractName: K,
    args: Parameters<Factories[K]['deploy']>,
  ): Promise<ReturnType<Factories[K]['deploy']>> {
    return this.deployContractFromFactory(
      chain,
      this.factories[contractName],
      contractName.toString(),
      args,
    );
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
    return this.deployProxy(
      chain,
      implementation as C,
      beacon.address,
      initArgs,
    );
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
      proxy.contract,
      proxy.addresses.beacon,
      initArgs,
    );
  }
}
