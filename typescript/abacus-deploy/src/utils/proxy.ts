import { BytesLike, ethers } from 'ethers';

import * as contracts from '@abacus-network/ts-interface/dist/abacus-core';
import { Deploy } from '../deploy';
import { CoreDeploy } from '../core/CoreDeploy';
import { ProxiedAddress } from '../config/addresses';

export type ProxyNames =
  | 'Outbox'
  | 'Inbox'
  | 'Governance'
  | 'BridgeToken'
  | 'BridgeRouter';

export class BeaconProxy<T extends ethers.Contract> {
  implementation: T;
  proxy: T;
  beacon: contracts.UpgradeBeacon;

  constructor(implementation: T, proxy: T, beacon: contracts.UpgradeBeacon) {
    this.implementation = implementation;
    this.proxy = proxy;
    this.beacon = beacon;
  }

  toObject(): ProxiedAddress {
    return {
      proxy: this.proxy.address,
      implementation: this.implementation.address,
      beacon: this.beacon.address,
    };
  }
}

/**
 * Deploys the UpgradeBeacon, Implementation and Proxy for a given contract
 *
 * @param T - The contract
 */
export async function deployProxy<T extends ethers.Contract>(
  name: ProxyNames,
  deploy: Deploy<any>,
  factory: ethers.ContractFactory,
  initData: BytesLike,
  ...deployArgs: any[]
): Promise<BeaconProxy<T>> {
  // deploy in order
  // we cast here because Factories don't have associated types
  // this is unsafe if the specified typevar doesn't match the factory output
  // :(
  console.log('deploying implementation')
  const implementation = await _deployImplementation(
    deploy,
    factory,
    deployArgs,
  );
  console.log('deployed')
  const beacon = await _deployBeacon(deploy, implementation);
  const proxy = await _deployProxy(deploy, beacon, initData);

  // proxy wait(x) implies implementation and beacon wait(>=x)
  // due to nonce ordering
  await proxy.deployTransaction.wait(deploy.chain.confirmations);

  // add Implementation to Etherscan verification
  deploy.verificationInput.push({
    name: `${name} Implementation`,
    address: implementation!.address,
    constructorArguments: deployArgs,
  });

  // add UpgradeBeacon to Etherscan verification
  deploy.verificationInput.push({
    name: `${name} UpgradeBeacon`,
    address: beacon!.address,
    constructorArguments: [implementation.address, deploy.ubcAddress!],
  });

  // add Proxy to Etherscan verification
  deploy.verificationInput.push({
    name: `${name} Proxy`,
    address: proxy!.address,
    constructorArguments: [beacon!.address, initData],
    isProxy: true,
  });

  return new BeaconProxy(
    implementation as T,
    factory.attach(proxy.address) as T,
    beacon,
  );
}

/**
 * Sets up a new proxy with the same beacon and implementation
 *
 * @param T - The contract
 */
export async function duplicate<T extends ethers.Contract>(
  name: ProxyNames,
  deploy: Deploy<any>,
  prev: BeaconProxy<T>,
  initData: BytesLike,
): Promise<BeaconProxy<T>> {
  const proxy = await _deployProxy(deploy, prev.beacon, initData);
  await proxy.deployTransaction.wait(deploy.chain.confirmations);

  // add UpgradeBeacon to etherscan verification
  // add Proxy to etherscan verification
  deploy.verificationInput.push({
    name: `${name} Proxy`,
    address: proxy!.address,
    constructorArguments: [prev.beacon!.address, initData],
    isProxy: true,
  });

  return new BeaconProxy(
    prev.implementation,
    prev.proxy.attach(proxy.address) as T,
    prev.beacon,
  );
}

/**
 * Deploys an Implementation for a given contract, updates the deploy with the
 * implementation verification info, and returns the implementation contract.
 *
 * @param T - The contract
 */
export async function deployImplementation<T extends ethers.Contract>(
  name: ProxyNames,
  deploy: Deploy<any>,
  factory: ethers.ContractFactory,
  ...deployArgs: any[]
): Promise<T> {
  const implementation = await _deployImplementation(
    deploy,
    factory,
    deployArgs,
  );
  await implementation.deployTransaction.wait(deploy.chain.confirmations);

  // add Implementation to Etherscan verification
  deploy.verificationInput.push({
    name: `${name} Implementation`,
    address: implementation!.address,
    constructorArguments: deployArgs,
  });
  return implementation as T;
}

/**
 * Given an existing BeaconProxy, returns a new BeaconProxy with a different implementation.
 *
 * @param T - The contract
 */
export function overrideBeaconProxyImplementation<T extends ethers.Contract>(
  implementation: T,
  deploy: CoreDeploy,
  factory: ethers.ContractFactory,
  beaconProxy: BeaconProxy<T>,
): BeaconProxy<T> {
  const beacon = contracts.UpgradeBeacon__factory.connect(
    beaconProxy.beacon.address,
    deploy.provider,
  );
  return new BeaconProxy(
    implementation as T,
    factory.attach(beaconProxy.proxy.address) as T,
    beacon,
  );
}

/**
 * Returns an UNWAITED implementation
 *
 * @dev The TX to deploy may still be in-flight
 * @dev We set manual gas here to suppress ethers's preflight checks
 *
 * @param deploy - The deploy
 * @param factory - The implementation factory object
 * @param deployArgs - The arguments to pass to the implementation constructor
 */
async function _deployImplementation<T extends ethers.Contract>(
  deploy: Deploy<any>,
  factory: ethers.ContractFactory,
  deployArgs: any[],
): Promise<T> {
  const implementation = await factory.deploy(...deployArgs, deploy.overrides);
  return implementation as T;
}

/**
 * Returns an UNWAITED beacon
 *
 * @dev The TX to deploy may still be in-flight
 * @dev We set manual gas here to suppress ethers's preflight checks
 *
 * @param deploy - The deploy
 * @param implementation - The implementation
 */
async function _deployBeacon(
  deploy: Deploy<any>,
  implementation: ethers.Contract,
): Promise<contracts.UpgradeBeacon> {
  let factory = new contracts.UpgradeBeacon__factory(deploy.chain.signer);

  let beacon = factory.deploy(
    implementation.address,
    deploy.ubcAddress!,
    deploy.overrides,
  );
  return beacon;
}

/**
 * Returns an UNWAITED proxy
 *
 * @dev The TX to deploy may still be in-flight
 * @dev We set manual gas here to suppress ethers's preflight checks
 *
 * @param deploy - The deploy
 * @param beacon - The UpgradeBeacon
 * @param implementation - The implementation
 */
async function _deployProxy<T>(
  deploy: Deploy<any>,
  beacon: contracts.UpgradeBeacon,
  initData: BytesLike,
): Promise<contracts.UpgradeBeaconProxy> {
  let factory = new contracts.UpgradeBeaconProxy__factory(deploy.chain.signer);

  return await factory.deploy(beacon.address, initData, deploy.overrides);
}
