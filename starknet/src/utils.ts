import { CONFIG } from './config.js';
import { ContractError, ErrorMessages } from './errors.js';

/**
 * @notice Represents different types of contract name validation errors
 */
export type ValidationError =
  | { type: 'empty' }
  | { type: 'tooLong'; maxLength: number }
  | { type: 'invalidChars'; chars: string[] }
  | { type: 'invalidPattern' };

/**
 * @notice Validates a contract name and returns any validation errors
 * @dev Checks for empty strings, length limits, forbidden characters, and pattern matching
 * @param name The contract name to validate
 * @returns An array of validation errors, empty if valid
 */
export function validateContractName(name: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check for empty or whitespace-only names
  if (!name.trim()) {
    errors.push({ type: 'empty' });
    return errors; // Return early as other checks don't matter
  }

  // Check length
  if (name.length > CONFIG.CONTRACT_NAME_VALIDATION.MAX_LENGTH) {
    errors.push({
      type: 'tooLong',
      maxLength: CONFIG.CONTRACT_NAME_VALIDATION.MAX_LENGTH,
    });
  }

  // Check for forbidden characters
  const foundForbiddenChars =
    CONFIG.CONTRACT_NAME_VALIDATION.FORBIDDEN_CHARS.filter((char) =>
      name.includes(char),
    );

  if (foundForbiddenChars.length > 0) {
    errors.push({ type: 'invalidChars', chars: foundForbiddenChars });
  }

  // Check pattern match
  if (!CONFIG.CONTRACT_NAME_VALIDATION.PATTERN.test(name)) {
    errors.push({ type: 'invalidPattern' });
  }

  return errors;
}

/**
 * @notice Gets a human-readable error message for validation errors
 * @param errors Array of validation errors
 * @returns A formatted error message
 */
export function getValidationErrorMessage(errors: ValidationError[]): string {
  if (errors.length === 0) return '';

  const messages = errors.map((error) => {
    switch (error.type) {
      case 'empty':
        return 'Contract name cannot be empty or only whitespace';
      case 'tooLong':
        return `Contract name cannot exceed ${error.maxLength} characters`;
      case 'invalidChars':
        return `Contract name contains invalid characters: ${error.chars.join(
          ' ',
        )}`;
      case 'invalidPattern':
        return 'Contract name can only contain letters, numbers, underscores, and hyphens';
    }
  });

  return messages.join('. ');
}

/**
 * @notice Validates a contract name and throws if invalid
 * @dev Combines validation and error throwing into a single function
 * @param name The contract name to validate
 * @throws {ContractError} If the name is invalid
 */
export function assertValidContractName(name: string): void {
  const errors = validateContractName(name);

  if (errors.length > 0) {
    throw new ContractError(
      ErrorMessages[CONFIG.ERROR_CODES.INVALID_INPUT],
      CONFIG.ERROR_CODES.INVALID_INPUT,
      {
        name,
        reason: getValidationErrorMessage(errors),
      },
    );
  }
}
