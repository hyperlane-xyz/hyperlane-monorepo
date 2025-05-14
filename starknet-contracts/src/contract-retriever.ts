import { CairoAssembly, CompiledContract } from 'starknet';

import { starknetContracts } from './artifacts/index.js';
import { ERR_CODES } from './const.js';
import { ContractError } from './errors.js';
import { ContractType, StarknetContractGroup } from './types.js';

/**
 * @notice Helper function to retrieve a specific artifact from a contract
 * @param name The name of the contract
 * @param contractType The type of contract
 * @param propertyKey The key of the artifact to retrieve (e.g., 'contract_class' or 'compiled_contract_class')
 * @param notFoundErrorCode The error code to use if the specific artifact is not found
 * @returns {CompiledContract | CairoAssembly} The requested contract artifact
 * @throws {ContractError} If the contract or artifact is not found, or if the contract type is invalid
 */
function _getContractArtifact<T extends CompiledContract | CairoAssembly>(
  name: string,
  contractType: ContractType,
  propertyKey: 'contract_class' | 'compiled_contract_class',
  notFoundErrorCode:
    | typeof ERR_CODES.SIERRA_NOT_FOUND
    | typeof ERR_CODES.CASM_NOT_FOUND,
): T {
  const group = getContractGroup(contractType);
  const contract = group[name];

  if (!contract) {
    throw new ContractError(ERR_CODES.CONTRACT_NOT_FOUND, {
      name,
      type: contractType,
    });
  }

  const artifact = contract[propertyKey];

  if (!artifact) {
    throw new ContractError(notFoundErrorCode, {
      name,
      type: contractType,
    });
  }

  return artifact as T;
}

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
  return _getContractArtifact<CompiledContract>(
    name,
    contractType,
    'contract_class',
    ERR_CODES.SIERRA_NOT_FOUND,
  );
}

export function getContractAbi<
  Type extends keyof (typeof starknetContracts)[ContractType.CONTRACT],
>(
  name: Type,
): (typeof starknetContracts)[ContractType.CONTRACT][Type]['contract_abi'] {
  const group = starknetContracts[ContractType.CONTRACT];
  if (!group) {
    throw new ContractError(ERR_CODES.INVALID_CONTRACT_TYPE, {
      contractType: ContractType.CONTRACT,
    });
  }
  return group[name].contract_abi;
}

const test = () => {
  const abi = getContractAbi('mailbox');
  return null;
};

/**
 * @notice Retrieves a CASM compiled contract
 * @param name The name of the contract to retrieve
 * @returns {CairoAssembly} The CASM contract data
 * @throws {ContractError} If the contract is not found
 */
export function getCompiledContractCasm(
  name: string,
  contractType: ContractType = ContractType.CONTRACT,
): CairoAssembly {
  return _getContractArtifact<CairoAssembly>(
    name,
    contractType,
    'compiled_contract_class',
    ERR_CODES.CASM_NOT_FOUND,
  );
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
