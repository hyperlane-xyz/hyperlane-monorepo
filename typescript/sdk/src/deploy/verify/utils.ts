import { ethers, utils } from 'ethers';

import { ZKSyncArtifact } from '@hyperlane-xyz/core';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { ExplorerFamily } from '../../metadata/chainMetadataTypes.js';
import { ChainMap, ChainName } from '../../types.js';

import { ContractVerificationInput } from './types.js';

const { Interface } = await import('@ethersproject/abi');

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
  expectedimplementation?: string,
): ContractVerificationInput {
  return {
    name: name.charAt(0).toUpperCase() + name.slice(1),
    address,
    constructorArguments,
    isProxy,
    expectedimplementation,
  };
}

export function getContractVerificationInput({
  name,
  contract,
  bytecode,
  isProxy,
  expectedimplementation,
}: {
  name: string;
  contract: ethers.Contract;
  bytecode: string;
  isProxy?: boolean;
  expectedimplementation?: Address;
}): ContractVerificationInput {
  const args = getConstructorArguments(contract, bytecode);
  return buildVerificationInput(
    name,
    contract.address,
    args,
    isProxy,
    expectedimplementation,
  );
}

export async function getContractVerificationInputForZKSync({
  name,
  contract,
  constructorArgs,
  artifact,
  isProxy,
  expectedimplementation,
}: {
  name: string;
  contract: ethers.Contract;
  constructorArgs: any[];
  artifact: ZKSyncArtifact;
  isProxy?: boolean;
  expectedimplementation?: Address;
}): Promise<ContractVerificationInput> {
  const args = encodeArguments(artifact.abi, constructorArgs);
  return buildVerificationInput(
    name,
    contract.address,
    args,
    isProxy,
    expectedimplementation,
  );
}

export function encodeArguments(abi: any, constructorArgs: any[]): string {
  const contractInterface = new Interface(abi);
  let deployArgumentsEncoded;
  try {
    deployArgumentsEncoded = contractInterface
      .encodeDeploy(constructorArgs)
      .replace('0x', '');
  } catch (error: any) {
    throw new Error('Cant encode constructor args');
  }

  return deployArgumentsEncoded;
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

/**
 * @notice Defines verification delay times for different blockchain explorer families.
 * @dev This constant object associates explorer families with specific delay times (in milliseconds)
 */
export const FamilyVerificationDelay = {
  [ExplorerFamily.Etherscan]: 40000,
} as const;
