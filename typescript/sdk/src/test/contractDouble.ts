/**
 * Builds a typed partial double of `T`, typically a typechain factory's
 * `connect` return. The provided members are type-checked against the real `T`
 * (so a misspelled or removed member is a compile error); only the final
 * widening — which sinon's `.returns`/`.resolves` requires — is cast.
 */
export function contractDouble<T>(members: Partial<T>): T {
  // CAST: sinon's `.returns` needs the exact contract type; `members` is a
  // partial test double whose keys are validated against `T` above.
  return members as T;
}
