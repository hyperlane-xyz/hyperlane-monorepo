import { types, Validator } from '@abacus-network/utils';

// Signs a checkpoint with the provided validators and returns
// the signatures sorted by validator addresses in ascending order
export async function getCheckpointSignatures(
  root: types.HexString,
  index: number,
  unsortedValidators: Validator[],
): Promise<string[]> {
  const validators = unsortedValidators.sort((a, b) => {
    // Remove the checksums for accurate comparison
    const aAddress = a.address.toLowerCase();
    const bAddress = b.address.toLowerCase();

    if (aAddress < bAddress) {
      return -1;
    } else if (aAddress > bAddress) {
      return 1;
    } else {
      return 0;
    }
  });

  const signedCheckpoints = await Promise.all(
    validators.map((validator) => validator.signCheckpoint(root, index)),
  );
  return signedCheckpoints.map(
    (signedCheckpoint) => signedCheckpoint.signature,
  );
}
