import { ethers, utils } from 'ethers';

import { ContractVerificationInput } from './types';

export function formatFunctionArguments(
  fragment: utils.Fragment,
  args: any[],
): any {
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
  return tx.data.replace(bytecode, '');
}

export function getContractVerificationInput(
  name: string,
  contract: ethers.Contract,
  bytecode: string,
  isProxy: boolean = name.endsWith('Proxy'),
): ContractVerificationInput {
  return {
    name: name.charAt(0).toUpperCase() + name.slice(1),
    address: contract.address,
    constructorArguments: getConstructorArguments(contract, bytecode),
    isProxy,
  };
}
