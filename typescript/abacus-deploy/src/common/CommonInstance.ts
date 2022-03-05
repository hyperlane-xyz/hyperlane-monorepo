import { types } from '@abacus-network/utils';
import { Instance } from '@abacus-network/abacus-deploy';
// import { VerificationInput } from '../verification/types';

export abstract class CommonInstance<T> extends Instance<any> {
  abstract transferOwnership(owner: types.Address): Promise<void>;
  // abstract getVerificationInput(): VerificationInput;

  /*
  static getContractVerificationInput(contract: ethers.Contract, bytecode: ethers.BytesLike) {
    const data = contract.deployTransaction.data
    const abi = contract.implementation.interface.deploy.inputs
    const encodedArguments = `0x${data.replace(bytecode, "")}`;
    const decoder = ethers.utils.defaultAbiCoder;
    const decoded = decoder.decode(abi, encodedArguments);
    console.log(decoded)
  }
  */
}
