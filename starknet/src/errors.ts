import { CONFIG } from './config.js';

export class ContractError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ContractError';
  }
}

export const ErrorMessages = {
  [CONFIG.ERROR_CODES.FILE_NOT_FOUND]: 'Contract file not found',
  [CONFIG.ERROR_CODES.PARSE_ERROR]: 'Failed to parse contract',
  [CONFIG.ERROR_CODES.INVALID_INPUT]: 'Invalid input parameters',
} as const;
