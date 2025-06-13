import { CairoAssembly, CompiledContract } from 'starknet';

import { starknetContracts } from './artifacts/index.js';
import { ERR_CODES } from './const.js';
import { ContractError } from './errors.js';
import { ContractClass, ContractType, StarknetContractGroup } from './types.js';

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
  return getContractData(name, contractType, ContractClass.SIERRA);
}

/**
 * @notice Retrieves a CASM compiled contract
 * @param name The name of the contract to retrieve
 * @param contractType The type of contract to retrieve
 * @returns {CairoAssembly} The CASM contract data
 * @throws {ContractError} If the contract is not found
 */
export function getCompiledContractCasm(
  name: string,
  contractType: ContractType = ContractType.CONTRACT,
): CairoAssembly {
  return getContractData(name, contractType, ContractClass.CASM);
}

/**
 * @notice Internal helper to retrieve contract data
 * @param name The name of the contract to retrieve
 * @param contractType The type of contract to retrieve
 * @param dataType The type of contract data to retrieve
 * @returns The requested contract data
 * @throws {ContractError} If the contract is not found
 */
function getContractData<T>(
  name: string,
  contractType: ContractType,
  dataType: ContractClass,
): T {
  const group = getContractGroup(contractType);
  const contract = group[name];

  if (!contract) {
    throw new ContractError(ERR_CODES.CONTRACT_NOT_FOUND, {
      name,
      type: contractType,
    });
  }

  if (!contract[dataType]) {
    throw new ContractError(ERR_CODES.SIERRA_NOT_FOUND, {
      name,
      type: contractType,
    });
  }

  return contract[dataType] as T;
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
