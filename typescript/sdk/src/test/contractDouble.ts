/**
 * Builds a typed partial double for a typechain factory's `connect` return.
 * The provided members are type-checked against the real contract `T` (so a
 * misspelled/removed method is a compile error); only the final widening —
 * which sinon's `.returns` requires — is cast.
 */
export function contractDouble<T>(members: Partial<T>): T {
  // CAST: sinon's `.returns` needs the exact contract type; `members` is a
  // partial test double whose keys are validated against `T` above.
  return members as T;
}
