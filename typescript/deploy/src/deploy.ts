import { Debugger, debug } from 'debug';
import { ethers } from 'ethers';

import {
  UpgradeBeaconProxy__factory,
  UpgradeBeacon__factory,
} from '@abacus-network/core';
import {
  AbacusContracts,
  AbacusFactories,
  BeaconProxyAddresses,
  ChainMap,
  ChainName,
  MultiProvider,
  ProxiedContract,
  objMap,
} from '@abacus-network/sdk';
import { ProxyKind } from '@abacus-network/sdk/dist/proxy';
import { types } from '@abacus-network/utils';

import {
  ContractVerificationInput,
  getContractVerificationInput,
} from './verify';

export interface DeployerOptions {
  logger?: Debugger;
}

export abstract class AbacusDeployer<
  Chain extends ChainName,
  Config,
  Factories extends AbacusFactories,
  Contracts extends AbacusContracts,
> {
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

  async deploy() {
    this.logger('Start Deploy');
    this.verificationInputs = objMap(this.configMap, () => []);
    const chains = this.multiProvider.chains();
    const entries: [Chain, Contracts][] = [];
    for (const chain of chains) {
      this.logger(`Deploying to ${chain}...`);
      const result = await this.deployContracts(chain, this.configMap[chain]);
      entries.push([chain, result]);
    }
    return Object.fromEntries(entries) as Record<Chain, Contracts>;
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
    const contract = await factory.deploy(...args);
    await contract.deployTransaction.wait(chainConnection.confirmations);
    const verificationInput = getContractVerificationInput(
      contractName.toString(),
      contract,
      factory.bytecode,
    );
    this.verificationInputs[chain].push(verificationInput);
    return contract;
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
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const signer = chainConnection.signer;
    const implementation = await this.deployContract<K>(
      chain,
      contractName,
      deployArgs,
    );
    const beacon = await new UpgradeBeacon__factory(signer).deploy(
      implementation.address,
      ubcAddress,
    );
    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const beaconProxy = await new UpgradeBeaconProxy__factory(signer).deploy(
      beacon.address,
      initData,
    );
    return new ProxiedContract<C, BeaconProxyAddresses>(
      implementation.attach(beaconProxy.address) as any,
      {
        kind: ProxyKind.UpgradeBeacon,
        proxy: beaconProxy.address,
        implementation: implementation.address,
        beacon: beacon.address,
      },
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
    const signer = this.multiProvider.getChainConnection(chain).signer!;
    const initData = proxy.contract.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const proxyAddresses = proxy.addresses as BeaconProxyAddresses;
    const newProxy = await new UpgradeBeaconProxy__factory(signer).deploy(
      proxyAddresses.beacon,
      initData,
    );
    return new ProxiedContract<C, BeaconProxyAddresses>(
      proxy.contract.attach(newProxy.address) as C,
      {
        ...proxyAddresses,
        proxy: newProxy.address,
      },
    );
  }
}
