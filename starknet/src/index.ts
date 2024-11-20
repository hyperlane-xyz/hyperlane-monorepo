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
export const getCompiledContract = (name: string): CompiledContract => {
  try {
    return JSON.parse(
      readFileSync(findContractFile(name, 'STANDARD'), 'utf-8'),
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
export const getCompiledContractCasm = (name: string): CairoAssembly => {
  try {
    return JSON.parse(
      readFileSync(findContractFile(name, 'COMPILED'), 'utf-8'),
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
 * @notice Finds the path to a contract file based on predefined patterns
 * @dev Searches for contract files in multiple predefined locations:
 *      - contracts_{name}{suffix}
 *      - token_{name}{suffix}
 * @param name The base name of the contract to find
 * @param suffix The type of contract file to look for (from CONFIG.SUFFIXES)
 * @returns {string} The full path to the first matching contract file
 * @throws {ContractError} If no matching file is found or the contract name is invalid
 */
function findContractFile(
  name: string,
  suffix: keyof typeof CONFIG.SUFFIXES,
): string {
  assertValidContractName(name);

  const suffixPath = CONFIG.SUFFIXES[suffix];
  const possiblePaths = [
    {
      type: 'contracts',
      path: `${TARGET_DEV_PATH}/contracts_${name}${suffixPath}`,
    },
    {
      type: 'token',
      path: `${TARGET_DEV_PATH}/token_${name}${suffixPath}`,
    },
  ];

  const existingPath = possiblePaths.find(({ path }) => existsSync(path));

  if (!existingPath) {
    throw new ContractError(
      ErrorMessages[CONFIG.ERROR_CODES.FILE_NOT_FOUND],
      CONFIG.ERROR_CODES.FILE_NOT_FOUND,
      {
        name,
        suffix,
        path: possiblePaths[0].path,
      },
    );
  }

  return existingPath.path;
}
