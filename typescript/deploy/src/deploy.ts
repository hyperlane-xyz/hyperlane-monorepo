import path from 'path';
import fs from 'fs';
import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { ChainName, NameOrDomain, MultiProvider } from '@abacus-network/sdk';
import {
  UpgradeBeacon,
  UpgradeBeacon__factory,
  UpgradeBeaconProxy,
  UpgradeBeaconProxy__factory,
} from '@abacus-network/core';

import { BeaconProxy } from './common';
import { TransactionConfig } from './config';
import { VerificationInput, getContractVerificationInput } from './verification';

export abstract class AbacusAppDeployer<T, C> extends MultiProvider {
  protected configs: Map<number, TransactionConfig>;
  protected addresses: Map<number, T>;
  protected verification: Map<number, VerificationInput>;

  constructor() {
    super();
    this.configs = new Map();
    this.addresses = new Map();
    this.verification = new Map();
  }

  getConfig(nameOrDomain: NameOrDomain): TransactionConfig | undefined {
    return this.configs.get(this.resolveDomain(nameOrDomain));
  }

  mustGetConfig(nameOrDomain: NameOrDomain): TransactionConfig {
    const config = this.getConfig(nameOrDomain);
    if (!config) {
      throw new Error(`TransactionConfig not found: ${nameOrDomain}`);
    }

    return config;
  }

  getAddresses(nameOrDomain: NameOrDomain): T | undefined {
    return this.addresses.get(this.resolveDomain(nameOrDomain));
  }

  mustGetAddresses(nameOrDomain: NameOrDomain): T {
    const addresses = this.getAddresses(nameOrDomain);
    if (!addresses) {
      throw new Error(`Addresses not found: ${nameOrDomain}`);
    }

    return addresses;
  }

  getVerification(nameOrDomain: NameOrDomain): VerificationInput | undefined {
    return this.verification.get(this.resolveDomain(nameOrDomain));
  }

  mustGetVerification(nameOrDomain: NameOrDomain): VerificationInput {
    const verification = this.getVerification(nameOrDomain);
    if (!verification) {
      throw new Error(`Verification not found: ${nameOrDomain}`);
    }

    return verification;
  }

  addVerificationInput(nameOrDomain: NameOrDomain, input: VerificationInput) {
    const domain = this.resolveDomain(nameOrDomain);
    const verification = this.verification.get(domain) || [];
    this.verification.set(domain, verification.concat(input))
  }

  abstract deployContracts(domain: types.Domain, config: C): Promise<T>;

  async deploy(config: C) {
    /*
    await this.ready();
    for (const domain of this.domainNumbers) {
      this.chains[domain] = CommonDeploy.fixOverrides(chains[domain]);
    }
    */
    for (const domain of this.domainNumbers) {
      if (this.addresses.has(domain)) throw new Error('cannot deploy twice');
      this.addresses.set(domain, await this.deployContracts(domain, config));
    }
  }

  // TODO(asa): How do we set isProxy to true for BeaconProxy verificaiton?
  async deployContract<L extends ethers.Contract>(
    nameOrDomain: NameOrDomain,
    contractName: string,
    factory: ethers.ContractFactory,
    ...args: any[]
  ): Promise<L> {
    const config = this.mustGetConfig(nameOrDomain);
    const contract = (await factory.deploy(...args, config.overrides)) as L;
    await contract.deployTransaction.wait(config.confirmations);
    this.addVerificationInput(nameOrDomain, [getContractVerificationInput(
      contractName,
      contract,
      factory.bytecode
    )]);
    return contract;
  }

  /**
   * Deploys the UpgradeBeacon, Implementation and Proxy for a given contract
   *
   * @param T - The contract
   */
  // TODO(asa): Fold this into abacusapp deployer
  async deployBeaconProxy<L extends ethers.Contract>(
    nameOrDomain: NameOrDomain,
    contractName: string,
    factory: ethers.ContractFactory,
    ubcAddress: types.Address,
    deployArgs: any[],
    initArgs: any[],
  ): Promise<BeaconProxy<L>> {
    const signer = this.mustGetSigner(nameOrDomain);
    const implementation: L = await this.deployContract(nameOrDomain, `${contractName} Implementation`, factory, ...deployArgs);
    const beacon: UpgradeBeacon = await this.deployContract(
      nameOrDomain, `${contractName} UpgradeBeacon`,
      new UpgradeBeacon__factory(signer),
      implementation.address,
      ubcAddress,
    );

    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const proxy: UpgradeBeaconProxy = await this.deployContract(
      nameOrDomain, `${contractName} Proxy`,
      new UpgradeBeaconProxy__factory(signer),
      beacon.address,
      initData,
    );
    // proxy wait(x) implies implementation and beacon wait(>=x)
    // due to nonce ordering
    await proxy.deployTransaction.wait(this.mustGetConfig(nameOrDomain).confirmations);
    return new BeaconProxy(
      implementation as L,
      proxy,
      beacon,
      factory.attach(proxy.address) as L,
    );
  }

  /**
   * Sets up a new proxy with the same beacon and implementation
   *
   * @param T - The contract
   */
  async duplicateBeaconProxy<L extends ethers.Contract>(
    nameOrDomain: NameOrDomain,
    contractName: string,
    beaconProxy: BeaconProxy<L>,
    initArgs: any[],
  ): Promise<BeaconProxy<L>> {
    const initData = beaconProxy.implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const proxy: UpgradeBeaconProxy = await this.deployContract(
      nameOrDomain, `${contractName} Proxy`,
      new UpgradeBeaconProxy__factory(this.mustGetSigner(nameOrDomain)),
      beaconProxy.beacon.address,
      initData,
    );

    return new BeaconProxy(
      beaconProxy.implementation,
      proxy,
      beaconProxy.beacon,
      beaconProxy.contract.attach(proxy.address) as L,
    );
  }

  /*
  async ready(): Promise<void> {
    await Promise.all(
      this.domainNumbers.map((domain) => this.mustGetConnection(domain).ready)
    );
  }
  */

  abstract configDirectory(directory: string): string;

  contractsDirectory(directory: string) {
    return path.join(this.configDirectory(directory), 'contracts');
  }

  contractsFilepath(directory: string, chain: ChainName) {
    return path.join(this.contractsDirectory(directory), `${chain}.json`);
  }

  verificationDirectory(directory: string) {
    return path.join(this.configDirectory(directory), 'verification');
  }

  writeOutput(directory: string) {
    this.writeContracts(directory);
    this.writeVerificationInput(directory);
  }

  writeContracts(directory: string) {
    for (const domain of this.domainNumbers) {
      AbacusAppDeployer.writeJson(
        path.join(
          this.contractsDirectory(directory),
          `${this.resolveDomainName(domain)}.json`,
        ),
        this.mustGetAddresses(domain))
    }
  }

  writeVerificationInput(directory: string) {
    for (const domain of this.domainNumbers) {
      AbacusAppDeployer.writeJson(
      path.join(
        this.verificationDirectory(directory),
        `${this.resolveDomainName(domain)}.json`,
      ),
      this.mustGetVerification(domain))
    }
  }

  static writeJson(filepath: string, obj: Object) {
    const dir = path.dirname(filepath);
    fs.mkdirSync(dir, { recursive: true });
    const contents = JSON.stringify(obj, null, 2);
    fs.writeFileSync(filepath, contents);
  }

  /*
  // this is currently a kludge to account for ethers issues
  static fixOverrides(chain: ChainConfig): ChainConfig {
    let overrides: ethers.Overrides = {};
    if (chain.supports1559) {
      overrides = {
        maxFeePerGas: chain.overrides.maxFeePerGas,
        maxPriorityFeePerGas: chain.overrides.maxPriorityFeePerGas,
        gasLimit: chain.overrides.gasLimit,
      };
    } else {
      overrides = {
        type: 0,
        gasPrice: chain.overrides.gasPrice,
        gasLimit: chain.overrides.gasLimit,
      };
    }
    return { ...chain, overrides };
  }
  */
}
