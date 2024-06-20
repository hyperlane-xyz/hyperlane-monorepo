import { ethers, utils } from 'ethers';

import { eqAddress } from '@hyperlane-xyz/utils';

import { ChainMap, ChainName } from '../../types.js';

import { ContractVerificationInput } from './types.js';

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

export function buildVerificationInput(
  name: string,
  address: string,
  constructorArguments: string,
  isProxy: boolean = name.endsWith('Proxy'),
): ContractVerificationInput {
  return {
    name: name.charAt(0).toUpperCase() + name.slice(1),
    address,
    constructorArguments,
    isProxy,
  };
}

export function getContractVerificationInput(
  name: string,
  contract: ethers.Contract,
  bytecode: string,
  isProxy?: boolean,
): ContractVerificationInput {
  const args = getConstructorArguments(contract, bytecode);
  return buildVerificationInput(name, contract.address, args, isProxy);
}

/**
 * Check if the artifact should be added to the verification inputs.
 * @param verificationInputs - The verification inputs for the chain.
 * @param chain - The chain to check.
 * @param artifact - The artifact to check.
 * @returns
 */
export function shouldAddVerificationInput(
  verificationInputs: ChainMap<ContractVerificationInput[]>,
  chain: ChainName,
  artifact: ContractVerificationInput,
): boolean {
  return !verificationInputs[chain].some(
    (existingArtifact) =>
      existingArtifact.name === artifact.name &&
      eqAddress(existingArtifact.address, artifact.address) &&
      existingArtifact.constructorArguments === artifact.constructorArguments &&
      existingArtifact.isProxy === artifact.isProxy,
  );
}
