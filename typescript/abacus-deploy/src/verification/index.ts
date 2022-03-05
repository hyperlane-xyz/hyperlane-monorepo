import { ethers } from 'ethers';

export { ContractVerificationInput, VerificationInput } from './types'

export function getConstructorArguments(contract: ethers.Contract, bytecode: string): any {
  const tx = contract.deployTransaction;
  if (tx === undefined) throw new Error('deploy transaction not found')
  const abi = contract.interface.deploy.inputs
  const encodedArguments = `0x${tx.data.replace(bytecode, "")}`;
  const decoder = ethers.utils.defaultAbiCoder;
  const decoded = decoder.decode(abi, encodedArguments);
  return decoded
}
