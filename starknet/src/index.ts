import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { CONFIG } from './config.js';
import { ContractError, ErrorMessages } from './errors.js';
import { CompiledContractCasm, ContractData } from './types.js';
import { assertValidContractName } from './utils.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const TARGET_DEV_PATH = join(currentDirectory, CONFIG.PATHS.MAIN);

/**
 * @notice Retrieves and parses the standard compiled contract data
 * @dev Reads the contract file with STANDARD suffix and parses it as JSON
 * @param name The name of the contract to retrieve
 * @returns {ContractData} The parsed contract data
 * @throws {ContractError} If the file is not found, cannot be parsed, or name is invalid
 */
export const getCompiledContract = (name: string): ContractData => {
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
 * @returns {CompiledContractCasm} The parsed CASM contract data
 * @throws {ContractError} If the file is not found, cannot be parsed, or name is invalid
 */
export const getCompiledContractCasm = (name: string): CompiledContractCasm => {
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
 * @notice Locates a contract file with the specified suffix
 * @dev Combines the target path with contract name and suffix, validates file existence
 * @param name The name of the contract to find
 * @param suffix The suffix type from CONFIG.SUFFIXES to append to the filename
 * @returns The full path to the contract file
 * @throws {ContractError} If the file is not found or name is invalid
 */
function findContractFile(
  name: string,
  suffix: keyof typeof CONFIG.SUFFIXES,
): string {
  assertValidContractName(name);
  const mainPath = `${TARGET_DEV_PATH}/${name}${CONFIG.SUFFIXES[suffix]}`;

  if (!existsSync(mainPath)) {
    throw new ContractError(
      ErrorMessages[CONFIG.ERROR_CODES.FILE_NOT_FOUND],
      CONFIG.ERROR_CODES.FILE_NOT_FOUND,
      {
        name,
        suffix,
        path: mainPath,
      },
    );
  }

  return mainPath;
}
