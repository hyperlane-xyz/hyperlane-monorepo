import { hash, type CompiledContract } from 'starknet';

import { starknetContracts } from './artifacts/index.js';
import { ERR_CODES } from './const.js';
import { ContractError } from './errors.js';
import { ContractType, StarknetContractGroup } from './types.js';

const compiledClassHashCache = new Map<string, string>();

/**
 * @notice Retrieves a compiled contract
 * @param name The name of the contract to retrieve
 * @param contractType The type of contract to retrieve
 * @returns {CompiledContract} The contract data
 * @throws {ContractError} If the contract is not found
 */
export function getCompiledContract(
  name: string,
  contractType: ContractType = ContractType.CONTRACT,
): CompiledContract {
  const contract = getContractArtifact(name, contractType);
  if (!contract.contract_class) {
    throw new ContractError(ERR_CODES.SIERRA_NOT_FOUND, {
      name,
      type: contractType,
    });
  }

  return contract.contract_class;
}

export function getContractArtifact(
  name: string,
  contractType: ContractType = ContractType.CONTRACT,
): StarknetContractGroup[string] {
  const group = getContractGroup(contractType);
  const contract = group[name];

  if (!contract) {
    throw new ContractError(ERR_CODES.CONTRACT_NOT_FOUND, {
      name,
      type: contractType,
    });
  }

  return contract;
}

export function getCompiledClassHash(
  name: string,
  contractType: ContractType = ContractType.CONTRACT,
): string | undefined {
  const cacheKey = `${contractType}:${name}`;
  const cached = compiledClassHashCache.get(cacheKey);
  if (cached) return cached;

  const contract = getContractArtifact(name, contractType);
  if (!contract.compiled_contract_class) return undefined;

  const compiledClassHash = hash.computeCompiledClassHash(
    contract.compiled_contract_class,
  );
  compiledClassHashCache.set(cacheKey, compiledClassHash);
  return compiledClassHash;
}

/**
 * @notice Helper function to get the correct contract group
 * @param type The type of contract to retrieve
 * @returns {StarknetContractGroup} The contract group
 * @throws {ContractError} If the contract group is non-existent
 */
function getContractGroup(type: ContractType): StarknetContractGroup {
  const group = starknetContracts[type];
  if (!group) {
    throw new ContractError(ERR_CODES.INVALID_CONTRACT_TYPE, {
      type,
    });
  }
  return group;
}
