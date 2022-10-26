import { Validator, types } from '@hyperlane-xyz/utils';

// Signs a checkpoint with the provided validators and returns
// the signatures sorted by validator addresses in ascending order
export async function signCheckpoint(
  root: types.HexString,
  index: number,
  unsortedValidators: Validator[],
): Promise<string[]> {
  const validators = unsortedValidators.sort((a, b) => {
    // Remove the checksums for accurate comparison
    const aAddress = a.address.toLowerCase();
    return aAddress.localeCompare(b.address.toLowerCase());
  });

  const signedCheckpoints = await Promise.all(
    validators.map((validator) => validator.signCheckpoint(root, index)),
  );
  return signedCheckpoints.map(
    (signedCheckpoint) => signedCheckpoint.signature as string, // cast is safe because signCheckpoint serializes to hex
  );
}
