import type { CompiledContract } from 'starknet';

import { ERR_CODES } from './const.js';
import { ContractError } from './errors.js';
import { starknetRuntimeContracts } from './runtime-artifacts/index.js';
import { ContractType, type StarknetRuntimeContractGroup } from './types.js';

function getRuntimeContractGroup(
  contractType: ContractType,
): StarknetRuntimeContractGroup {
  switch (contractType) {
    case ContractType.CONTRACT:
      return starknetRuntimeContracts.contracts;
    case ContractType.TOKEN:
      return starknetRuntimeContracts.token;
    case ContractType.MOCK:
      return starknetRuntimeContracts.mocks;
    default:
      throw new ContractError(ERR_CODES.INVALID_CONTRACT_TYPE, {
        type: contractType,
      });
  }
}

function getRuntimeContract(name: string, contractType: ContractType) {
  const group = getRuntimeContractGroup(contractType);
  const contract = group[name];
  if (!contract) {
    throw new ContractError(ERR_CODES.CONTRACT_NOT_FOUND, {
      name,
      type: contractType,
    });
  }

  return contract;
}

export function getContractAbi(
  name: string,
  contractType: ContractType = ContractType.CONTRACT,
): CompiledContract['abi'] {
  return getRuntimeContract(name, contractType).abi;
}

export function getContractClassHash(
  name: string,
  contractType: ContractType = ContractType.CONTRACT,
): string {
  return getRuntimeContract(name, contractType).classHash;
}

export { ContractType } from './types.js';
