import { expect } from 'chai';
import { existsSync, readFileSync, readdirSync } from 'fs';

import { SignatureLike } from '@hyperlane-xyz/utils';

import { ModuleType } from '../types.js';

import { MultisigMetadata, MultisigMetadataBuilder } from './multisig.js';
import { Fixture } from './types.test.js';

const path = '../../solidity/fixtures/multisig';
const files = existsSync(path) ? readdirSync(path) : [];
const fixtures: Fixture<MultisigMetadata>[] = files
  .map((f) => JSON.parse(readFileSync(`${path}/${f}`, 'utf8')))
  .map((contents) => {
    const type = contents.type as MultisigMetadata['type'];

    const { dummy: _dummy, ...signatureValues } = contents.signatures;
    const signatures = Object.values<SignatureLike>(signatureValues);

    let decoded: MultisigMetadata;
    if (type === ModuleType.MERKLE_ROOT_MULTISIG) {
      const { dummy: _dummy, ...branchValues } = contents.prefix.proof;
      const branch = Object.values<string>(branchValues);
      decoded = {
        type,
        proof: {
          branch,
          leaf: contents.prefix.id,
          index: contents.prefix.signedIndex,
        },
        checkpoint: {
          root: '',
          index: contents.prefix.index,
          merkle_tree_hook_address: contents.prefix.merkleTree,
        },
        signatures,
      };
    } else {
      decoded = {
        type,
        checkpoint: {
          root: contents.prefix.root,
          index: contents.prefix.signedIndex,
          merkle_tree_hook_address: contents.prefix.merkleTree,
        },
        signatures,
      };
    }
    return { decoded, encoded: contents.encoded };
  });

describe('MultisigMetadataBuilder', () => {
  fixtures.forEach((fixture, i) => {
    it(`should encode fixture ${i}`, () => {
      expect(MultisigMetadataBuilder.encode(fixture.decoded)).to.equal(
        fixture.encoded,
      );
    });

    it(`should decode fixture ${i}`, () => {
      expect(
        MultisigMetadataBuilder.decode(fixture.encoded, fixture.decoded.type),
      ).to.deep.equal(fixture.decoded);
    });
  });
});
