import { ethers } from 'ethers';

import {
  UpgradeBeaconProxy__factory,
  UpgradeBeacon__factory,
} from '@abacus-network/core';
import {
  ChainMap,
  ChainName,
  MultiProvider,
  objMap,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { ProxiedContract } from './proxy';
import {
  ContractVerificationInput,
  getContractVerificationInput,
} from './verify';

// TODO: Make AppDeployer generic on AbacusApp and return instance from deploy()
export abstract class AbacusAppDeployer<Networks extends ChainName, C, A> {
  verificationInputs: ChainMap<Networks, ContractVerificationInput[]>;
  private networkSequence: Networks[];
  private networkResults: [Networks, A][];

  constructor(
    protected readonly multiProvider: MultiProvider<Networks>,
    protected readonly configMap: ChainMap<Networks, C>,
  ) {
    this.verificationInputs = objMap(this.configMap, () => []);
    this.networkSequence = Object.keys(this.configMap) as Networks[];
    this.networkResults = [];
  }

  abstract deployContracts(network: Networks, config: C): Promise<A>;

  async deploy() {
    while (this.networkResults.length < this.networkSequence.length) {
      let network = this.networkSequence[this.networkResults.length];
      console.log(`Deploying to ${network}...`);
      try {
        const result = await this.deployContracts(
          network,
          this.configMap[network],
        );
        this.networkResults.push([network, result]);
      } catch (error) {
        console.error(`Failed to deploy to ${network}: ${error}`);
        break;
      }
    }
    return Object.fromEntries(this.networkResults) as Record<Networks, A>;
  }

  async deployContract<F extends ethers.ContractFactory>(
    network: Networks,
    contractName: string,
    factory: F,
    args: Parameters<F['deploy']>,
  ): Promise<ReturnType<F['deploy']>> {
    const domainConnection = this.multiProvider.getDomainConnection(network);
    const contract = await factory.deploy(...args, domainConnection.overrides);
    await contract.deployTransaction.wait(domainConnection.confirmations);
    const verificationInput = getContractVerificationInput(
      contractName,
      contract,
      factory.bytecode,
    );
    this.verificationInputs[network].push(verificationInput);
    return contract;
  }

  /**
   * Deploys the UpgradeBeacon, Implementation and Proxy for a given contract
   *
   */
  async deployProxiedContract<
    F extends ethers.ContractFactory,
    C extends ethers.Contract = Awaited<ReturnType<F['deploy']>>,
  >(
    network: Networks,
    contractName: string,
    factory: F,
    deployArgs: Parameters<F['deploy']>,
    ubcAddress: types.Address,
    initArgs: Parameters<C['initialize']>,
  ) {
    const domainConnection = this.multiProvider.getDomainConnection(network);
    const signer = domainConnection.signer;
    const implementation = await this.deployContract(
      network,
      `${contractName} Implementation`,
      factory,
      deployArgs,
    );
    const beacon = await this.deployContract(
      network,
      `${contractName} UpgradeBeacon`,
      new UpgradeBeacon__factory(signer),
      [implementation.address, ubcAddress],
    );

    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const proxy = await this.deployContract(
      network,
      `${contractName} Proxy`,
      new UpgradeBeaconProxy__factory(signer),
      [beacon.address, initData],
    );

    const proxiedContract = new ProxiedContract(factory.attach(proxy.address), {
      proxy: proxy.address,
      implementation: implementation.address,
      beacon: beacon.address,
    });
    return proxiedContract;
  }

  /**
   * Sets up a new proxy with the same beacon and implementation
   *
   */
  async duplicateProxiedContract<C extends ethers.Contract>(
    network: Networks,
    contractName: string,
    proxy: ProxiedContract<C>,
    initArgs: Parameters<C['initialize']>,
  ) {
    const domainConnection = this.multiProvider.getDomainConnection(network);
    const initData = proxy.contract.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const newProxy = await this.deployContract(
      network,
      `${contractName} Proxy`,
      new UpgradeBeaconProxy__factory(domainConnection.signer!),
      [proxy.addresses.beacon, initData],
    );

    const newProxiedContract = new ProxiedContract(
      proxy.contract.attach(newProxy.address),
      {
        ...proxy.addresses,
        proxy: newProxy.address,
      },
    );
    return newProxiedContract;
  }
}
