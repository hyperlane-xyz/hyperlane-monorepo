import { expect } from 'chai';
import { utils } from 'ethers';

import { TREE_DEPTH, ZERO_HASH, branchRoot } from '../src/merkle.js';

const hashPair = (a: string, b: string) =>
  utils.solidityKeccak256(['bytes32', 'bytes32'], [a, b]);

describe('branchRoot', () => {
  it('reconstructs the root with all-zero siblings (index 0)', () => {
    const leaf = '0x' + '11'.repeat(32);
    const proof = Array(TREE_DEPTH).fill(ZERO_HASH);

    let expected = leaf;
    for (let i = 0; i < TREE_DEPTH; i++) {
      expected = hashPair(expected, ZERO_HASH);
    }

    expect(branchRoot(leaf, proof, 0).toLowerCase()).to.equal(
      expected.toLowerCase(),
    );
  });

  it('selects left/right sibling based on the index bit', () => {
    const leaf = '0x' + '22'.repeat(32);
    const sibling0 = '0x' + '33'.repeat(32);
    const proof = [sibling0, ...Array(TREE_DEPTH - 1).fill(ZERO_HASH)];

    // index=1 → bit 0 = 1 → first level hashes (sibling, current)
    let expectedAtIndex1 = hashPair(sibling0, leaf);
    for (let i = 1; i < TREE_DEPTH; i++) {
      expectedAtIndex1 = hashPair(expectedAtIndex1, ZERO_HASH);
    }
    expect(branchRoot(leaf, proof, 1).toLowerCase()).to.equal(
      expectedAtIndex1.toLowerCase(),
    );

    // index=0 → bit 0 = 0 → first level hashes (current, sibling)
    let expectedAtIndex0 = hashPair(leaf, sibling0);
    for (let i = 1; i < TREE_DEPTH; i++) {
      expectedAtIndex0 = hashPair(expectedAtIndex0, ZERO_HASH);
    }
    expect(branchRoot(leaf, proof, 0).toLowerCase()).to.equal(
      expectedAtIndex0.toLowerCase(),
    );
  });

  it('handles a non-trivial bit pattern (index = 5)', () => {
    // index=5 → bits at positions 0,1,2 = 1,0,1
    const leaf = '0x' + 'aa'.repeat(32);
    const siblings = Array.from(
      { length: TREE_DEPTH },
      (_, i) => '0x' + (i + 1).toString(16).padStart(2, '0').repeat(32),
    );
    const indexBits = [1, 0, 1, ...Array(TREE_DEPTH - 3).fill(0)];

    let expected = leaf;
    for (let i = 0; i < TREE_DEPTH; i++) {
      expected =
        indexBits[i] === 1
          ? hashPair(siblings[i], expected)
          : hashPair(expected, siblings[i]);
    }

    expect(branchRoot(leaf, siblings, 5).toLowerCase()).to.equal(
      expected.toLowerCase(),
    );
  });

  it('rejects proofs of the wrong length', () => {
    expect(() => branchRoot('0x' + '00'.repeat(32), [], 0)).to.throw(
      /32 elements/,
    );
  });
});
