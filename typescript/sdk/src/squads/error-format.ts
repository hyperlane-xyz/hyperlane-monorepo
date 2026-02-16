import { inspectInstanceOf, inspectPropertyValue } from './inspection.js';

const GENERIC_OBJECT_STRING_PATTERN = /^\[object .+\]$/;
const TRAILING_COLON_WITH_OPTIONAL_SPACING_PATTERN = /\s*:\s*$/;
const OBJECT_FREEZE = Object.freeze as <Value>(value: Value) => Readonly<Value>;
const STRING_FUNCTION = String;
const STRING_TRIM = String.prototype.trim;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const STRING_REPLACE = String.prototype.replace as (
  this: string,
  searchValue: string | RegExp,
  replaceValue: string,
) => string;
const SET_CONSTRUCTOR = Set as new <Value>(
  values?: Iterable<Value>,
) => Set<Value>;
const REGEXP_PROTOTYPE_TEST = RegExp.prototype.test as (
  this: RegExp,
  value: string,
) => boolean;
const REGEXP_PROTOTYPE_EXEC = RegExp.prototype.exec as (
  this: RegExp,
  value: string,
) => RegExpExecArray | null;

function objectFreezeValue<Value>(value: Value): Readonly<Value> {
  return OBJECT_FREEZE(value);
}

function stringFromValue(value: unknown): string {
  return STRING_FUNCTION(value);
}

export const BUILTIN_SQUADS_ERROR_LABELS = objectFreezeValue([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
] as const);

const GENERIC_ERROR_LABELS = createSetValue<string>();
const SET_ADD = Set.prototype.add;
for (const label of BUILTIN_SQUADS_ERROR_LABELS) {
  SET_ADD.call(GENERIC_ERROR_LABELS, stringToLowerCase(label));
}
const SET_HAS = Set.prototype.has;
const ERROR_LABEL_WITH_MESSAGE_PATTERN = /^([A-Za-z]*Error)\s*:\s*(.+)$/;

function createSetValue<Value>(values?: Iterable<Value>): Set<Value> {
  return new SET_CONSTRUCTOR(values);
}

function setHasValue<Value>(set: Set<Value>, value: Value): boolean {
  return SET_HAS.call(set, value);
}

function stringTrim(value: string): string {
  return STRING_TRIM.call(value);
}

function stringToLowerCase(value: string): string {
  return STRING_TO_LOWER_CASE.call(value);
}

function stringReplaceValue(
  value: string,
  searchValue: string | RegExp,
  replaceValue: string,
): string {
  return STRING_REPLACE.call(value, searchValue, replaceValue);
}

function regexpTest(pattern: RegExp, value: string): boolean {
  return REGEXP_PROTOTYPE_TEST.call(pattern, value);
}

function regexpExec(pattern: RegExp, value: string): RegExpExecArray | null {
  return REGEXP_PROTOTYPE_EXEC.call(pattern, value);
}

function normalizeErrorLabel(value: string): string {
  return stringToLowerCase(
    stringReplaceValue(
      stringTrim(value),
      TRAILING_COLON_WITH_OPTIONAL_SPACING_PATTERN,
      '',
    ),
  );
}

export function isGenericObjectStringifiedValue(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const normalizedValue = stringReplaceValue(
    stringTrim(value),
    TRAILING_COLON_WITH_OPTIONAL_SPACING_PATTERN,
    '',
  );
  return regexpTest(GENERIC_OBJECT_STRING_PATTERN, normalizedValue);
}

export function normalizeStringifiedSquadsError(
  formattedError: unknown,
): string | undefined {
  if (typeof formattedError !== 'string') {
    return undefined;
  }

  const trimmedFormattedError = stringTrim(formattedError);
  const normalizedErrorLabel = normalizeErrorLabel(trimmedFormattedError);

  if (
    trimmedFormattedError.length === 0 ||
    isGenericObjectStringifiedValue(trimmedFormattedError) ||
    setHasValue(GENERIC_ERROR_LABELS, normalizedErrorLabel) ||
    isLowSignalBuiltinErrorWithLowSignalMessage(trimmedFormattedError)
  ) {
    return undefined;
  }

  return formattedError;
}

function isLowSignalBuiltinErrorWithLowSignalMessage(value: string): boolean {
  const match = regexpExec(ERROR_LABEL_WITH_MESSAGE_PATTERN, value);
  if (!match) {
    return false;
  }

  const [, errorLabel, message] = match;
  if (!setHasValue(GENERIC_ERROR_LABELS, stringToLowerCase(errorLabel))) {
    return false;
  }

  const normalizedMessageLabel = normalizeErrorLabel(message);
  return (
    normalizedMessageLabel.length === 0 ||
    setHasValue(GENERIC_ERROR_LABELS, normalizedMessageLabel) ||
    isGenericObjectStringifiedValue(message)
  );
}

function normalizeUnknownStringCandidate(value: unknown): string | undefined {
  return typeof value === 'string'
    ? normalizeStringifiedSquadsError(value)
    : undefined;
}

export interface StringifyUnknownSquadsErrorOptions {
  preferErrorMessageForErrorInstances?: boolean;
  preferErrorStackForErrorInstances?: boolean;
  formatObject?: (value: object) => string | undefined;
  placeholder?: string;
}

export const DEFAULT_SQUADS_ERROR_PLACEHOLDER = '[unstringifiable error]';

export function stringifyUnknownSquadsError(
  error: unknown,
  options?: StringifyUnknownSquadsErrorOptions,
): string;
export function stringifyUnknownSquadsError(
  error: unknown,
  options?: unknown,
): string;
export function stringifyUnknownSquadsError(
  error: unknown,
  options: unknown = {},
): string {
  const optionsRecord =
    options && typeof options === 'object'
      ? (options as Record<string, unknown>)
      : undefined;
  const readOptionCandidate = (key: string): unknown => {
    if (!optionsRecord) {
      return undefined;
    }

    try {
      return optionsRecord[key];
    } catch {
      return undefined;
    }
  };

  const placeholderCandidate = readOptionCandidate('placeholder');
  const placeholder =
    typeof placeholderCandidate === 'string' &&
    stringTrim(placeholderCandidate).length > 0
      ? placeholderCandidate
      : DEFAULT_SQUADS_ERROR_PLACEHOLDER;
  const preferErrorMessageForErrorInstances =
    readOptionCandidate('preferErrorMessageForErrorInstances') === true;
  const preferErrorStackForErrorInstances =
    readOptionCandidate('preferErrorStackForErrorInstances') === true;
  const formatObjectCandidate = readOptionCandidate('formatObject');
  const formatObject =
    typeof formatObjectCandidate === 'function'
      ? (formatObjectCandidate as (value: object) => string | undefined)
      : undefined;
  const stringifyErrorFallback = (value: unknown): string => {
    try {
      const normalizedError = normalizeStringifiedSquadsError(
        stringFromValue(value),
      );
      return normalizedError ?? placeholder;
    } catch {
      return placeholder;
    }
  };
  const readNormalizedCandidate = (
    readValue: () => unknown,
  ): string | undefined => {
    try {
      return normalizeUnknownStringCandidate(readValue());
    } catch {
      return undefined;
    }
  };
  const readNormalizedPropertyCandidate = (
    targetValue: unknown,
    property: PropertyKey,
  ): string | undefined => {
    const { propertyValue, readError } = inspectPropertyValue(
      targetValue,
      property,
    );
    if (readError) {
      return undefined;
    }
    return normalizeUnknownStringCandidate(propertyValue);
  };

  const { matches: isError, readFailed: errorInstanceReadFailed } =
    inspectInstanceOf(error, Error);
  if (!errorInstanceReadFailed && isError) {
    if (preferErrorStackForErrorInstances) {
      const normalizedStack = readNormalizedPropertyCandidate(error, 'stack');
      if (normalizedStack) {
        return normalizedStack;
      }
    }

    if (preferErrorMessageForErrorInstances) {
      const normalizedMessage = readNormalizedPropertyCandidate(
        error,
        'message',
      );
      if (normalizedMessage) {
        return normalizedMessage;
      }
    }

    return stringifyErrorFallback(error);
  }

  if (typeof error === 'string') {
    const normalizedError = normalizeUnknownStringCandidate(error);
    return normalizedError ?? placeholder;
  }

  if (error && typeof error === 'object') {
    const normalizedStack = readNormalizedPropertyCandidate(error, 'stack');
    if (normalizedStack) {
      return normalizedStack;
    }

    const normalizedMessage = readNormalizedPropertyCandidate(error, 'message');
    if (normalizedMessage) {
      return normalizedMessage;
    }

    if (typeof formatObject === 'function') {
      const normalizedFormattedObject = readNormalizedCandidate(() =>
        formatObject(error),
      );
      if (normalizedFormattedObject) {
        return normalizedFormattedObject;
      }
    }
  }

  return stringifyErrorFallback(error);
}
