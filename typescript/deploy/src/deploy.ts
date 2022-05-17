import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';

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
export abstract class AbacusAppDeployer<Chain extends ChainName, C, A> {
  verificationInputs: ChainMap<Chain, ContractVerificationInput[]>;

  constructor(
    protected readonly multiProvider: MultiProvider<Chain>,
    protected readonly configMap: ChainMap<Chain, C>,
  ) {
    this.verificationInputs = objMap(configMap, () => []);
  }

  abstract deployContracts(chain: Chain, config: C): Promise<A>;

  async deploy() {
    this.verificationInputs = objMap(this.configMap, () => []);
    const chains = Object.keys(this.configMap) as Chain[];
    const entries: [Chain, A][] = [];
    for (const chain of chains) {
      console.log(`Deploying to ${chain}...`);
      const result = await this.deployContracts(
        chain,
        this.configMap[chain],
      );
      entries.push([chain, result]);
    }
    return Object.fromEntries(entries) as Record<Chain, A>;
  }

  async deployContract<F extends ethers.ContractFactory>(
    chain: Chain,
    contractName: string,
    factory: F,
    args: Parameters<F['deploy']>,
  ): Promise<ReturnType<F['deploy']>> {
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const contract = await factory.deploy(...args, chainConnection.overrides);
    await contract.deployTransaction.wait(chainConnection.confirmations);
    const verificationInput = getContractVerificationInput(
      contractName,
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
    F extends ethers.ContractFactory,
    C extends ethers.Contract = Awaited<ReturnType<F['deploy']>>,
  >(
    chain: Chain,
    contractName: string,
    factory: F,
    deployArgs: Parameters<F['deploy']>,
    ubcAddress: types.Address,
    initArgs: Parameters<C['initialize']>,
  ) {
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const signer = chainConnection.signer;
    const implementation = await this.deployContract(
      chain,
      `${contractName} Implementation`,
      factory,
      deployArgs,
    );
    const beacon = await this.deployContract(
      chain,
      `${contractName} UpgradeBeacon`,
      new UpgradeBeacon__factory(signer),
      [implementation.address, ubcAddress],
    );

    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const proxy = await this.deployContract(
      chain,
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
    chain: Chain,
    contractName: string,
    proxy: ProxiedContract<C>,
    initArgs: Parameters<C['initialize']>,
  ) {
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const initData = proxy.contract.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const newProxy = await this.deployContract(
      chain,
      `${contractName} Proxy`,
      new UpgradeBeaconProxy__factory(chainConnection.signer!),
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

  writeOutput(directory: string, addresses: ChainMap<Chain, A>) {
    this.writeContracts(addresses, path.join(directory, 'addresses.ts'));
    this.writeVerification(path.join(directory, 'verification'));
  }

  writeContracts(addresses: ChainMap<Chain, A>, filepath: string) {
    const contents = `export const addresses = ${AbacusAppDeployer.stringify(
      addresses,
    )}`;
    AbacusAppDeployer.write(filepath, contents);
  }

  writeVerification(directory: string) {
    objMap(this.verificationInputs, (chain, input) => {
      AbacusAppDeployer.writeJson(
        path.join(directory, `${chain}.json`),
        input,
      );
    });
  }

  static stringify(obj: Object) {
    return JSON.stringify(obj, null, 2);
  }

  static write(filepath: string, contents: string) {
    const dir = path.dirname(filepath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filepath, contents);
  }

  static writeJson(filepath: string, obj: Object) {
    AbacusAppDeployer.write(filepath, AbacusAppDeployer.stringify(obj));
  }
}
