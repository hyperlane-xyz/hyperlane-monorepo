export const CONFIG = {
  PATHS: {
    MAIN: 'target/dev',
  },
  SUFFIXES: {
    STANDARD: '.contract_class.json',
    COMPILED: '.compiled_contract_class.json',
  },
  ERROR_CODES: {
    FILE_NOT_FOUND: 'FILE_NOT_FOUND',
    PARSE_ERROR: 'PARSE_ERROR',
    INVALID_INPUT: 'INVALID_INPUT',
  },
  CONTRACT_NAME_VALIDATION: {
    MAX_LENGTH: 128,
    MIN_LENGTH: 1,
    FORBIDDEN_CHARS: [
      '..',
      '/',
      '\\',
      ' ',
      '*',
      '?',
      '<',
      '>',
      '|',
      '"',
      ':',
    ] as const,
    PATTERN: /^[a-zA-Z0-9_-]+$/,
  },
} as const;
