import { Debugger, debug } from 'debug';
import { ethers } from 'ethers';

import {
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
  Factories extends AbacusFactories,
  Contracts extends AbacusContracts,
> {
  public deployedContracts: Partial<Record<Chain, Contracts>> = {};

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
    partialDeployment: Partial<Record<Chain, Contracts>> = this
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
    const deployedChains = Object.keys(this.deployedContracts);
    const configChains = Object.keys(this.configMap);
    const targetChains = this.multiProvider
      .chains()
      .filter(
        (chain) =>
          configChains.includes(chain) && !deployedChains.includes(chain),
      );
    this.logger(`Start deploy to ${targetChains}`);
    // wait until all promises are resolved / rejected
    for (const chain of targetChains) {
      const chainConnection = this.multiProvider.getChainConnection(chain);
      this.logger(
        `Deploying to ${chain} from ${await chainConnection.getAddressUrl()}...`,
      );
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
    return this.deployedContracts as ChainMap<Chain, Contracts>;
  }

  async deployContract<K extends keyof Factories>(
    chain: Chain,
    contractName: K,
    args: Parameters<Factories[K]['deploy']>,
  ): Promise<ReturnType<Factories[K]['deploy']>> {
    this.logger(`Deploy ${contractName.toString()} on ${chain}`);
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const factory = this.factories[contractName].connect(
      chainConnection.signer!,
    );
    const contract = await factory.deploy(...args, chainConnection.overrides);
    this.logger(
      `Pending deployment ${chainConnection.getTxUrl(
        contract.deployTransaction,
      )}`,
    );
    await contract.deployTransaction.wait(chainConnection.confirmations);
    const verificationInput = getContractVerificationInput(
      contractName.toString(),
      contract,
      factory.bytecode,
    );
    this.verificationInputs[chain].push(verificationInput);
    return contract;
  }

  protected async deployProxy<C extends ethers.Contract>(
    chain: Chain,
    implementation: C,
    beaconAddress: string,
    initArgs: Parameters<C['initialize']>,
  ) {
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const beaconProxy = await new UpgradeBeaconProxy__factory(
      chainConnection.signer!,
    ).deploy(beaconAddress, initData, chainConnection.overrides);
    await chainConnection.handleTx(beaconProxy.deployTransaction);
    const proxyVerification = getContractVerificationInput(
      'UpgradeBeaconProxy',
      beaconProxy,
      UpgradeBeaconProxy__factory.bytecode,
    );
    this.verificationInputs[chain].push(proxyVerification);

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
    const implementation = await this.deployContract<K>(
      chain,
      contractName,
      deployArgs,
    );
    this.logger(`Proxy ${contractName.toString()} on ${chain}`);
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const signer = chainConnection.signer;
    const beacon = await new UpgradeBeacon__factory(signer).deploy(
      implementation.address,
      ubcAddress,
      chainConnection.overrides,
    );
    await chainConnection.handleTx(beacon.deployTransaction);
    const beaconVerification = getContractVerificationInput(
      'UpgradeBeacon',
      beacon,
      UpgradeBeacon__factory.bytecode,
    );
    this.verificationInputs[chain].push(beaconVerification);

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
