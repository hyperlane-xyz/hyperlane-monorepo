export interface SierraProgram {
  sierra_program: string[];
  sierra_program_debug_info?: {
    type_information?: unknown;
    libfunc_declarations?: unknown;
    user_func_declarations?: unknown;
  };
  contract_class_version: string;
  entry_points_by_type: {
    CONSTRUCTOR: EntryPoint[];
    EXTERNAL: EntryPoint[];
    L1_HANDLER: EntryPoint[];
  };
  abi: ContractAbi;
}

export interface EntryPoint {
  selector: string;
  function_idx: number;
}

export interface ContractAbi {
  type: string;
  name?: string;
  inputs?: AbiInput[];
  outputs?: AbiOutput[];
  state_mutability?: string;
  functions: AbiFunction[];
  events: AbiEvent[];
  structs: AbiStruct[];
  l1_handler?: boolean;
}

export interface AbiFunction {
  name: string;
  inputs: AbiInput[];
  outputs: AbiOutput[];
  state_mutability: string;
}

export interface AbiEvent {
  name: string;
  inputs: AbiInput[];
}

export interface AbiInput {
  name: string;
  type: string;
}

export interface AbiOutput {
  type: string;
}

export interface AbiStruct {
  name: string;
  size: number;
  members: AbiStructMember[];
}

export interface AbiStructMember {
  name: string;
  type: string;
  offset: number;
}

// Update the main ContractData interface
export interface ContractData extends SierraProgram {
  [key: string]: unknown; // Keep this for backward compatibility
}

export interface CompiledContractCasm {
  prime: string; // e.g. "0x800000000000011000000000000000000000000000000000000000000000001"
  compiler_version: string; // e.g. "2.6.4"
  bytecode: string[]; // Array of hex strings representing bytecode instructions
}
