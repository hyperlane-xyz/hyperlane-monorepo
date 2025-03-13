import { CairoAssembly, CompiledContract } from 'starknet';

import { starknetContracts } from './artifacts/index.js';
import { CONFIG } from './config.js';
import { ContractError } from './errors.js';

export interface StarknetContractGroup {
  [name: string]: {
    contract_class: CompiledContract;
    compiled_contract_class: CairoAssembly;
  };
}
/**
 * @notice Contract file type enum
 */
export enum ContractType {
  CONTRACT = 'contracts_',
  TOKEN = 'token_',
  MOCK = 'mock_',
}

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

    if (!contract?.contract_class) {
      throw new Error('Contract not found or missing Sierra class');
    }

    return contract.contract_class;
  } catch (_error) {
    throw new ContractError(CONFIG.CONTRACT_ERROR_CODES.FILE_NOT_FOUND, {
      name,
      type: contractType,
    });
  }
}

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
  try {
    const group = getContractGroup(contractType);
    const contract = group[name];

    if (!contract?.compiled_contract_class) {
      throw new Error('Contract not found or missing CASM class');
    }

    return contract.compiled_contract_class;
  } catch (_error) {
    throw new ContractError(CONFIG.CONTRACT_ERROR_CODES.FILE_NOT_FOUND, {
      name,
      type: contractType,
    });
  }
}

/**
 * @notice Helper function to get the correct contract group
 */
function getContractGroup(type: ContractType): StarknetContractGroup {
  switch (type) {
    case ContractType.CONTRACT:
      return starknetContracts.contracts;
    case ContractType.TOKEN:
      return starknetContracts.tokens;
    case ContractType.MOCK:
      return starknetContracts.mocks;
    default:
      throw new Error('Invalid contract type');
  }
}
