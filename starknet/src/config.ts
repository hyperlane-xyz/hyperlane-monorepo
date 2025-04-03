export const CONFIG = {
  CONTRACT_FILE_SUFFIXES: {
    SIERRA_JSON: '.contract_class.json', // Sierra is the high-level representation
    ASSEMBLY_JSON: '.compiled_contract_class.json', // Cairo assembly (CASM) is the low-level bytecode
  },
  CONTRACT_ERROR_CODES: {
    FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  },
} as const;
