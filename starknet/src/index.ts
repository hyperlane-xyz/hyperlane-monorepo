import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { CairoAssembly, CompiledContract } from 'starknet';
import { fileURLToPath } from 'url';

import { CONFIG } from './config.js';
import { ContractError, ErrorMessages } from './errors.js';
import { assertValidContractName } from './utils.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const TARGET_DEV_PATH = join(currentDirectory, CONFIG.PATHS.MAIN);

/**
 * @notice Retrieves and parses the standard compiled contract data
 * @dev Reads the contract file with STANDARD suffix and parses it as JSON
 * @param name The name of the contract to retrieve
 * @returns {CompiledContract} The parsed contract data
 * @throws {ContractError} If the file is not found, cannot be parsed, or name is invalid
 */
export const getCompiledContract = (
  name: string,
  contractType?: ContractType,
): CompiledContract => {
  try {
    return JSON.parse(
      readFileSync(findContractFile(name, 'STANDARD', contractType), 'utf-8'),
    );
  } catch (error: unknown) {
    if (error instanceof ContractError) throw error;
    throw new ContractError(
      ErrorMessages[CONFIG.ERROR_CODES.PARSE_ERROR],
      CONFIG.ERROR_CODES.PARSE_ERROR,
      {
        name,
        error: (error as Error).message,
      },
    );
  }
};

/**
 * @notice Retrieves and parses the CASM compiled contract data
 * @dev Reads the contract file with COMPILED suffix and parses it as JSON
 * @param name The name of the contract to retrieve
 * @returns {CairoAssembly} The parsed CASM contract data
 * @throws {ContractError} If the file is not found, cannot be parsed, or name is invalid
 */
export const getCompiledContractCasm = (
  name: string,
  contractType?: ContractType,
): CairoAssembly => {
  try {
    return JSON.parse(
      readFileSync(findContractFile(name, 'COMPILED', contractType), 'utf-8'),
    );
  } catch (error: unknown) {
    if (error instanceof ContractError) throw error;
    throw new ContractError(
      ErrorMessages[CONFIG.ERROR_CODES.PARSE_ERROR],
      CONFIG.ERROR_CODES.PARSE_ERROR,
      {
        name,
        error: (error as Error).message,
      },
    );
  }
};

/**
 * @notice Contract file type enum
 */
export enum ContractType {
  CONTRACT = 'contracts_',
  TOKEN = 'token_',
  MOCK = 'mock_',
}

/**
 * @notice Finds the path to a contract file based on predefined patterns
 * @param name The base name of the contract to find
 * @param suffix The type of contract file to look for (from CONFIG.SUFFIXES)
 * @param type Optional contract type prefix (defaults to CONTRACT)
 * @returns {string} The full path to the contract file
 * @throws {ContractError} If file is not found or the contract name is invalid
 */
function findContractFile(
  name: string,
  suffix: keyof typeof CONFIG.SUFFIXES,
  type: ContractType = ContractType.CONTRACT,
): string {
  assertValidContractName(name);

  const suffixPath = CONFIG.SUFFIXES[suffix];
  const path = `${TARGET_DEV_PATH}/${type}${name}${suffixPath}`;

  if (!existsSync(path)) {
    throw new ContractError(
      ErrorMessages[CONFIG.ERROR_CODES.FILE_NOT_FOUND],
      CONFIG.ERROR_CODES.FILE_NOT_FOUND,
      { name, suffix, path },
    );
  }

  return path;
}
