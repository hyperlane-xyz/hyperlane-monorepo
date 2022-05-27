import { Debugger, debug } from 'debug';
import { ethers } from 'ethers';

import {
  UpgradeBeaconProxy__factory,
  UpgradeBeacon__factory,
} from '@abacus-network/core';
import {
  ChainMap,
  ChainName,
  MultiProvider,
  ProxiedAddress,
  objMap,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { ProxiedContract } from './proxy';
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

  abstract deployContracts(
    chain: Chain,
    config: Config,
  ): Promise<AbacusContracts>;

  async deploy() {
    this.logger('Start Deploy');
    this.verificationInputs = objMap(this.configMap, () => []);
    const chains = this.multiProvider.chains();
    const entries: [Chain, AbacusContracts][] = [];
    for (const chain of chains) {
      this.logger(`Deploying to ${chain}...`);
      const result = await this.deployContracts(chain, this.configMap[chain]);
      entries.push([chain, result]);
    }
    return Object.fromEntries(entries) as Record<Chain, AbacusContracts>;
  }

  async deployContract<K extends keyof Factories>(
    chain: Chain,
    contractName: K,
    args: Parameters<Factories[K]['deploy']>,
  ): Promise<ReturnType<Factories[K]['deploy']>> {
    this.logger(`Deploy ${contractName.toString()} on ${chain}`);
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const factory = this.factories[contractName];
    const contract = await factory.deploy(...args, chainConnection.overrides);
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
  async deployProxiedContract<K extends keyof Factories>(
    chain: Chain,
    contractName: K,
    deployArgs: Parameters<Factories[K]['deploy']>,
    ubcAddress: types.Address,
    initArgs: Parameters<
      Awaited<ReturnType<Factories[K]['deploy']>>['initialize']
    >,
  ): Promise<ProxiedContract<Awaited<ReturnType<Factories[K]['deploy']>>>> {
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
    const proxiedContract = new ProxiedContract(
      implementation.attach(beaconProxy.address),
      {
        proxy: beaconProxy.address,
        implementation: implementation.address,
        beacon: beacon.address,
      },
    );
    return proxiedContract as ProxiedContract<
      Awaited<ReturnType<Factories[K]['deploy']>>
    >;
  }

  /**
   * Sets up a new proxy with the same beacon and implementation
   *
   */
  async duplicateProxiedContract<C extends ethers.Contract>(
    chain: Chain,
    proxy: ProxiedContract<C>,
    initArgs: Parameters<C['initialize']>,
  ): Promise<ProxiedContract<C>> {
    const signer = this.multiProvider.getChainConnection(chain).signer!;
    const initData = proxy.contract.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const newProxy = await new UpgradeBeaconProxy__factory(signer).deploy(
      proxy.addresses.beacon,
      initData,
    );
    const newProxiedContract = new ProxiedContract<C>(
      proxy.contract.attach(newProxy.address) as C,
      {
        ...proxy.addresses,
        proxy: newProxy.address,
      },
    );
    return newProxiedContract;
  }
}
