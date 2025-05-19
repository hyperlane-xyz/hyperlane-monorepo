export const CONTRACT_SUFFIXES = {
  SIERRA_JSON: '.contract_class.json', // Sierra is the high-level representation
  ASSEMBLY_JSON: '.compiled_contract_class.json', // Cairo assembly (CASM) is the low-level bytecode
} as const;

export const ERR_CODES = {
  INVALID_CONTRACT_TYPE: 'INVALID_CONTRACT_TYPE',
  CONTRACT_NOT_FOUND: 'CONTRACT_NOT_FOUND',
  SIERRA_NOT_FOUND: 'SIERRA_NOT_FOUND',
  CASM_NOT_FOUND: 'CASM_NOT_FOUND',
} as const;
