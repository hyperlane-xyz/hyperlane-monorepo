import { ethers, utils } from 'ethers';

import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { ChainMap, ChainName } from '../../types.js';
import { ZkSyncArtifact } from '../../utils/zksync.js';

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
  artifact: ZkSyncArtifact;
  isProxy?: boolean;
  expectedimplementation?: Address;
}): Promise<ContractVerificationInput> {
  const args = await encodeArguments(artifact.abi, constructorArgs);
  return buildVerificationInput(
    name,
    contract.address,
    args,
    isProxy,
    expectedimplementation,
  );
}

export async function encodeArguments(abi: any, constructorArgs: any[]) {
  const { Interface } = await import('@ethersproject/abi');

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
