import {
  UpgradeBeaconProxy__factory,
  UpgradeBeacon__factory
} from '@abacus-network/core';
import { ChainName, ChainSubsetMap, MultiProvider } from '@abacus-network/sdk';
import { objMap, promiseObjAll } from '@abacus-network/sdk/dist/utils';
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { ProxiedContract } from './proxy';
import {
  ContractVerificationInput,
  getContractVerificationInput
} from './verify';

export abstract class AbacusAppDeployer<Networks extends ChainName, C, A> {
  verificationInputs: ChainSubsetMap<Networks, ContractVerificationInput[]>;

  constructor(
    protected readonly multiProvider: MultiProvider<Networks>,
    protected readonly configMap: ChainSubsetMap<Networks, C>,
  ) {
    this.verificationInputs = objMap(configMap, () => []);
  }

  abstract deployContracts(network: Networks, config: C): Promise<A>;

  async deploy() {
    this.verificationInputs = objMap(this.configMap, () => []);
    await this.multiProvider.ready();
    const addressMap = objMap(this.configMap, (network, config) =>
      this.deployContracts(network, config),
    );
    return promiseObjAll<Record<Networks, A>>(addressMap);
  }

  async deployContract<F extends ethers.ContractFactory>(
    network: Networks,
    contractName: string,
    factory: F,
    args: Parameters<F['deploy']>,
  ): Promise<ReturnType<F['deploy']>> {
    const domainConnection = this.multiProvider.getDomainConnection(network);
    const contract = await factory.deploy(args, domainConnection.overrides);
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

  writeOutput(directory: string, addresses: ChainSubsetMap<Networks, A>) {
    this.writeContracts(addresses, path.join(directory, 'addresses.ts'));
    this.writeVerification(path.join(directory, 'verification'));
  }

  writeContracts(addresses: ChainSubsetMap<Networks, A>, filepath: string) {
    const contents = `export const addresses = ${AbacusAppDeployer.stringify(
      addresses,
    )}`;
    AbacusAppDeployer.write(filepath, contents);
  }

  writeVerification(directory: string) {
    objMap(this.verificationInputs, (network, input) => {
      AbacusAppDeployer.writeJson(
        path.join(directory, `${network}.json`),
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
