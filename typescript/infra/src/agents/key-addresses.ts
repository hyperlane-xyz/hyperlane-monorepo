export interface KeyAsAddress {
  identifier: string;
  address: string;
}

export function isKeyAsAddressArray(value: unknown): value is KeyAsAddress[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        'identifier' in entry &&
        typeof entry.identifier === 'string' &&
        'address' in entry &&
        typeof entry.address === 'string',
    )
  );
}

export function reconcilePersistedKeyAddresses(
  existingKeys: KeyAsAddress[],
  currentKeys: KeyAsAddress[],
  preserveExistingKeys: boolean,
): KeyAsAddress[] {
  if (!preserveExistingKeys) {
    return currentKeys;
  }

  const mergedByIdentifier = new Map<string, KeyAsAddress>(
    existingKeys.map((key) => [key.identifier, key]),
  );
  for (const key of currentKeys) {
    mergedByIdentifier.set(key.identifier, key);
  }
  return [...mergedByIdentifier.values()];
}
