export const CONSTANTS = {
  CONTRACT_FILE_SUFFIXES: {
    SIERRA_JSON: '.contract_class.json', // Sierra is the high-level representation
    ASSEMBLY_JSON: '.compiled_contract_class.json', // Cairo assembly (CASM) is the low-level bytecode
  },
  CONTRACT_ERROR_CODES: {
    INVALID_CONTRACT_GROUP: 'INVALID_CONTRACT_GROUP',
    CONTRACT_NOT_FOUND: 'CONTRACT_NOT_FOUND',
    SIERRA_NOT_FOUND: 'SIERRA_NOT_FOUND',
  },
} as const;
