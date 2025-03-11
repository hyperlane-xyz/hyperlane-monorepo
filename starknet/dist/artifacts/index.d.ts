import type { CairoAssembly, CompiledContract } from 'starknet';

export interface StarknetContractGroup {
  [name: string]: {
    contract_class?: CompiledContract;
    compiled_contract_class?: CairoAssembly;
  };
}

export interface StarknetContracts {
  contracts: StarknetContractGroup;
  tokens: StarknetContractGroup;
  mocks: StarknetContractGroup;
}

export declare const starknetContracts: StarknetContracts;
