export type GetOwnObjectFieldOptions = {
  disallowedFields?: ReadonlySet<string>;
};

export function getOwnObjectField(
  value: unknown,
  field: string,
  options?: GetOwnObjectFieldOptions,
): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }

  if (options?.disallowedFields?.has(field)) {
    return undefined;
  }

  try {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  try {
    return (value as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

export function hasOwnObjectField(value: unknown, field: string): boolean {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }

  try {
    return Object.prototype.hasOwnProperty.call(value, field);
  } catch {
    return false;
  }
}

export function cloneOwnEnumerableObject(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return null;
  }

  let keys: string[];
  try {
    keys = Object.keys(value as Record<string, unknown>);
  } catch {
    return null;
  }

  const clonedObject = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    clonedObject[key] = getOwnObjectField(value, key);
  }

  return clonedObject;
}
