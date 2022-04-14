import {
  UpgradeBeacon,
  UpgradeBeaconProxy,
  UpgradeBeaconProxy__factory,
  UpgradeBeacon__factory,
} from '@abacus-network/core';
import { ChainName, MultiProvider, NameOrDomain } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { ProxiedContract } from './proxy';
import { getContractVerificationInput, VerificationInput } from './verify';

export abstract class AbacusAppDeployer<T, C> extends MultiProvider {
  protected addresses: Map<number, T>;
  protected verification: Map<number, VerificationInput>;

  constructor() {
    super();
    this.addresses = new Map();
    this.verification = new Map();
  }

  getAddresses(nameOrDomain: NameOrDomain): T | undefined {
    return this.getFromMap(nameOrDomain, this.addresses);
  }

  mustGetAddresses(nameOrDomain: NameOrDomain): T {
    return this.mustGetFromMap(nameOrDomain, this.addresses, 'Addresses');
  }

  getVerification(nameOrDomain: NameOrDomain): VerificationInput | undefined {
    return this.getFromMap(nameOrDomain, this.verification);
  }

  mustGetVerification(nameOrDomain: NameOrDomain): VerificationInput {
    return this.mustGetFromMap(nameOrDomain, this.verification, 'Verification');
  }

  get addressesRecord(): Partial<Record<ChainName, T>> {
    const addresses: Partial<Record<ChainName, T>> = {};
    this.domainNumbers.forEach(
      (domain) =>
        (addresses[this.mustResolveDomainName(domain)] =
          this.mustGetAddresses(domain)),
    );
    return addresses;
  }

  addVerificationInput(nameOrDomain: NameOrDomain, input: VerificationInput) {
    const domain = this.resolveDomain(nameOrDomain);
    const verification = this.verification.get(domain) || [];
    this.verification.set(domain, verification.concat(input));
  }

  abstract deployContracts(domain: types.Domain, config: C): Promise<T>;

  async deploy(config: C) {
    await this.ready();
    for (const domain of this.domainNumbers) {
      if (this.addresses.has(domain)) throw new Error('cannot deploy twice');
      this.addresses.set(domain, await this.deployContracts(domain, config));
    }
  }

  async deployContract<
    C extends ethers.Contract,
    F extends ethers.ContractFactory,
  >(
    nameOrDomain: NameOrDomain,
    contractName: string,
    factory: F,
    args: Parameters<F['deploy']>,
  ): Promise<C> {
    const overrides = this.getOverrides(nameOrDomain);
    const contract = (await factory.deploy(args, overrides)) as C;
    await contract.deployTransaction.wait(this.getConfirmations(nameOrDomain));
    this.addVerificationInput(nameOrDomain, [
      getContractVerificationInput(
        contractName,
        contract,
        factory.bytecode,
        contractName.includes(' Proxy'),
      ),
    ]);
    return contract;
  }

  /**
   * Deploys the UpgradeBeacon, Implementation and Proxy for a given contract
   *
   */
  async deployProxiedContract<
    C extends ethers.Contract,
    F extends ethers.ContractFactory,
  >(
    nameOrDomain: NameOrDomain,
    contractName: string,
    factory: F,
    deployArgs: Parameters<F['deploy']>,
    ubcAddress: types.Address,
    initArgs: Parameters<C['initialize']>,
  ): Promise<ProxiedContract<C>> {
    const signer = this.mustGetSigner(nameOrDomain);
    const implementation = await this.deployContract(
      nameOrDomain,
      `${contractName} Implementation`,
      factory,
      deployArgs,
    );
    const beacon: UpgradeBeacon = await this.deployContract(
      nameOrDomain,
      `${contractName} UpgradeBeacon`,
      new UpgradeBeacon__factory(signer),
      [implementation.address, ubcAddress],
    );

    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const proxy: UpgradeBeaconProxy = await this.deployContract(
      nameOrDomain,
      `${contractName} Proxy`,
      new UpgradeBeaconProxy__factory(signer),
      [beacon.address, initData],
    );
    // proxy wait(x) implies implementation and beacon wait(>=x)
    // due to nonce ordering
    await proxy.deployTransaction.wait(this.getConfirmations(nameOrDomain));
    return new ProxiedContract(factory.attach(proxy.address) as C, {
      proxy: proxy.address,
      implementation: implementation.address,
      beacon: beacon.address,
    });
  }

  /**
   * Sets up a new proxy with the same beacon and implementation
   *
   */
  async duplicateProxiedContract<C extends ethers.Contract>(
    nameOrDomain: NameOrDomain,
    contractName: string,
    contract: ProxiedContract<C>,
    initArgs: Parameters<C['initialize']>,
  ): Promise<ProxiedContract<C>> {
    const initData = contract.contract.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const proxy: UpgradeBeaconProxy = await this.deployContract(
      nameOrDomain,
      `${contractName} Proxy`,
      new UpgradeBeaconProxy__factory(this.mustGetSigner(nameOrDomain)),
      [contract.addresses.beacon, initData],
    );

    return new ProxiedContract(contract.contract.attach(proxy.address) as C, {
      ...contract.addresses,
      proxy: proxy.address,
    });
  }

  async ready(): Promise<void> {
    await Promise.all(
      this.domainNumbers.map(
        (domain) =>
          (this.mustGetProvider(domain) as ethers.providers.JsonRpcProvider)
            .ready,
      ),
    );
  }

  writeOutput(directory: string) {
    this.writeContracts(path.join(directory, 'addresses.ts'));
    this.writeVerification(path.join(directory, 'verification'));
  }

  writeContracts(filepath: string) {
    const contents = `export const addresses = ${AbacusAppDeployer.stringify(
      this.addressesRecord,
    )}`;
    AbacusAppDeployer.write(filepath, contents);
  }

  writeVerification(directory: string) {
    for (const name of this.domainNames) {
      AbacusAppDeployer.writeJson(
        path.join(directory, `${name}.json`),
        this.mustGetVerification(name),
      );
    }
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
