import { CairoAssembly, CompiledContract } from 'starknet';

export interface StarknetContractGroup {
  [name: string]: {
    contract_class: CompiledContract;
    compiled_contract_class: CairoAssembly;
  };
}
/**
 * @notice Contract file type enum
 */
export declare enum ContractType {
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
export declare function getCompiledContract(
  name: string,
  contractType?: ContractType,
): CompiledContract;
/**
 * @notice Retrieves a CASM compiled contract
 * @param name The name of the contract to retrieve
 * @returns {CairoAssembly} The CASM contract data
 * @throws {ContractError} If the contract is not found
 */
export declare function getCompiledContractCasm(
  name: string,
  contractType?: ContractType,
): CairoAssembly;
//# sourceMappingURL=index.d.ts.map
