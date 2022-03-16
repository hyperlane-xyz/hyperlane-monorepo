import { ethers } from 'ethers';
import {
  UpgradeBeacon__factory,
  UpgradeBeaconProxy__factory,
} from '@abacus-network/core';
import { BeaconProxy } from '../common';

import {
  ContractVerificationName,
  ContractVerificationInput,
  VerificationInput,
  BeaconProxyPrefix,
} from './types';

function getConstructorArguments(
  contract: ethers.Contract,
  bytecode: string,
): any {
  const tx = contract.deployTransaction;
  if (tx === undefined) throw new Error('deploy transaction not found');
  const abi = contract.interface.deploy.inputs;
  const encodedArguments = `0x${tx.data.replace(bytecode, '')}`;
  const coerce = (t: any, value: any) => {
    if (t.startsWith('uint')) {
      return value.toNumber();
    }
    return value;
  };
  const decoder = new ethers.utils.AbiCoder(coerce);
  const decoded = decoder.decode(abi, encodedArguments);
  return decoded;
}

export function getContractVerificationInput(
  name: ContractVerificationName,
  contract: ethers.Contract,
  bytecode: string,
  isProxy?: boolean,
): ContractVerificationInput {
  return {
    name,
    address: contract.address,
    constructorArguments: getConstructorArguments(contract, bytecode),
    isProxy,
  };
}

export function getBeaconProxyVerificationInput(
  name: BeaconProxyPrefix,
  contract: BeaconProxy<any>,
  bytecode: string,
): VerificationInput {
  const implementation: ContractVerificationInput = {
    name: `${name} Implementation`,
    address: contract.implementation.address,
    constructorArguments: getConstructorArguments(
      contract.implementation,
      bytecode,
    ),
  };
  const beacon: ContractVerificationInput = {
    name: `${name} UpgradeBeacon`,
    address: contract.beacon.address,
    constructorArguments: getConstructorArguments(
      contract.beacon,
      UpgradeBeacon__factory.bytecode,
    ),
  };
  const proxy: ContractVerificationInput = {
    name: `${name} Proxy`,
    address: contract.proxy.address,
    constructorArguments: getConstructorArguments(
      contract.proxy,
      UpgradeBeaconProxy__factory.bytecode,
    ),
    isProxy: true,
  };
  return [implementation, beacon, proxy];
}
