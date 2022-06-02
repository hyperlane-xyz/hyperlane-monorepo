import { Fragment } from '@ethersproject/abi';
import { ethers } from 'ethers';

import { ContractVerificationInput } from './types';

export function formatFunctionArguments(fragment: Fragment, args: any[]) {
  const params = Object.fromEntries(
    fragment.inputs.map((input, index) => [input.name, args[index]]),
  );
  return JSON.stringify(params, null, 2);
}

export function getConstructorArguments(
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
  name: string,
  contract: ethers.Contract,
  bytecode: string,
  isProxy: boolean = name.endsWith('Proxy'),
): ContractVerificationInput {
  return {
    name,
    address: contract.address,
    constructorArguments: getConstructorArguments(contract, bytecode),
    isProxy,
  };
}
