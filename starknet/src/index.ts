import { CompiledContract } from 'starknet';

import { starknetContracts } from './artifacts/index.js';
import { CONFIG } from './config.js';
import { ContractError } from './errors.js';
import { ContractType, StarknetContractGroup } from './types.js';

/**
 * @notice Retrieves a compiled contract
 * @param name The name of the contract to retrieve
 * @returns {CompiledContract} The contract data
 * @throws {ContractError} If the contract is not found
 */
export function getCompiledContract(
  name: string,
  contractType: ContractType = ContractType.CONTRACT,
): CompiledContract {
  try {
    const group = getContractGroup(contractType);
    const contract = group[name];

    if (!contract) {
      throw new ContractError(CONFIG.CONTRACT_ERROR_CODES.CONTRACT_NOT_FOUND, {
        name,
        type: contractType,
      });
    }

    if (!contract.contract_class) {
      throw new ContractError(CONFIG.CONTRACT_ERROR_CODES.SIERRA_NOT_FOUND, {
        name,
        type: contractType,
      });
    }

    return contract.contract_class;
  } catch (error) {
    if (error instanceof ContractError) {
      throw error;
    }

    throw new ContractError('Unknown error', {
      name,
      type: contractType,
    });
  }
}

/**
 * @notice Helper function to get the correct contract group
 */
function getContractGroup(type: ContractType): StarknetContractGroup {
  const group = starknetContracts[type];
  if (!group) {
    throw new ContractError(
      CONFIG.CONTRACT_ERROR_CODES.INVALID_CONTRACT_GROUP,
      {
        type,
      },
    );
  }
  return group;
}
