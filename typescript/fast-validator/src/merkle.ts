import { utils } from 'ethers';

import { HexString, assert } from '@hyperlane-xyz/utils';

export const TREE_DEPTH = 32;

const ZERO_HASH = '0x' + '00'.repeat(32);

/**
 * Reconstructs the merkle root from a leaf, its proof, and its index.
 *
 * Matches `MerkleLib.branchRoot` in solidity/contracts/libs/Merkle.sol —
 * at each level, the index bit selects whether the sibling is on the left
 * (bit=1) or right (bit=0) of the running hash.
 */
export function branchRoot(
  leaf: HexString,
  proof: HexString[],
  index: number | bigint,
): HexString {
  assert(
    proof.length === TREE_DEPTH,
    `merkle proof must have ${TREE_DEPTH} elements, got ${proof.length}`,
  );
  let current = leaf;
  const idx = BigInt(index);
  for (let i = 0; i < TREE_DEPTH; i++) {
    const sibling = proof[i];
    const bit = (idx >> BigInt(i)) & 1n;
    current = utils.solidityKeccak256(
      ['bytes32', 'bytes32'],
      bit === 1n ? [sibling, current] : [current, sibling],
    );
  }
  return current;
}

export { ZERO_HASH };
