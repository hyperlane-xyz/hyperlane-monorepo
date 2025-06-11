import type { CairoAssembly, CompiledContract } from 'starknet';

/**
 * Represents a group of Starknet contracts
 * both Sierra (contract_class) and CASM (compiled_contract_class) formats.
 */
export interface StarknetContractGroup {
  [name: string]: {
    contract_class: CompiledContract;
    compiled_contract_class: CairoAssembly;
  };
}

/**
 * Defines the overall structure for organizing Starknet contracts
 * into logical categories (contracts, token, mocks).
 */
export interface StarknetContracts {
  contracts: StarknetContractGroup;
  token: StarknetContractGroup;
  mocks: StarknetContractGroup;
}

/**
 * @notice Contract file type enum
 */
export enum ContractType {
  CONTRACT = 'contracts',
  TOKEN = 'token',
  MOCK = 'mocks',
}

export enum ContractClass {
  SIERRA = 'contract_class',
  CASM = 'compiled_contract_class',
}
