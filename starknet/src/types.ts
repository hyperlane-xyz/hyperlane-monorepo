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
export enum ContractType {
  CONTRACT = 'contracts',
  TOKEN = 'token',
  MOCK = 'mocks',
}

export enum ContractClass {
  SIERRA = 'contract_class',
  CASM = 'compiled_contract_class',
}
