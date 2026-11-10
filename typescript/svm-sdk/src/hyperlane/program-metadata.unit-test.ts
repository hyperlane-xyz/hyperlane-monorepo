/* eslint-disable import/no-nodejs-modules */
import { createHash } from 'node:crypto';

import { expect } from 'chai';

import { HYPERLANE_SVM_PROGRAM_BYTES } from './program-bytes.js';
import { HYPERLANE_SVM_PROGRAM_METADATA } from './program-metadata.js';

describe('HYPERLANE_SVM_PROGRAM_METADATA', () => {
  it('matches every embedded program', () => {
    expect(Object.keys(HYPERLANE_SVM_PROGRAM_METADATA)).to.deep.equal(
      Object.keys(HYPERLANE_SVM_PROGRAM_BYTES),
    );

    for (const [program, bytes] of Object.entries(
      HYPERLANE_SVM_PROGRAM_BYTES,
    )) {
      const metadataEntry = Object.entries(HYPERLANE_SVM_PROGRAM_METADATA).find(
        ([metadataProgram]) => metadataProgram === program,
      );

      expect(metadataEntry).not.to.equal(undefined);
      if (!metadataEntry) throw new Error(`Missing metadata for ${program}`);
      const [, metadata] = metadataEntry;

      expect(metadata.byteLength).to.equal(bytes.byteLength);
      expect(metadata.sha256).to.equal(
        createHash('sha256').update(bytes).digest('hex'),
      );
    }
  });
});
