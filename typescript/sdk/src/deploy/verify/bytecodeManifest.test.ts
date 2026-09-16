import { expect } from 'chai';
import { utils } from 'ethers';
// eslint-disable-next-line import/no-nodejs-modules
import fs from 'fs';
// eslint-disable-next-line import/no-nodejs-modules
import os from 'os';
// eslint-disable-next-line import/no-nodejs-modules
import path from 'path';

import {
  computeMaskedRuntimeHash,
  flattenImmutableReferences,
  flattenLinkReferences,
  generateManifestFromBuildArtifact,
  generateManifestFromBuildInfoDir,
  maskRanges,
  stripMetadata,
  type SolcBuildArtifact,
} from './bytecodeManifest.js';

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value));
}

describe('bytecodeManifest', () => {
  describe('stripMetadata', () => {
    it('strips a valid CBOR tail', () => {
      expect(stripMetadata('0x6001aabb0002')).to.equal('6001');
    });

    it('returns too-short input as-is', () => {
      expect(stripMetadata('0f')).to.equal('0f');
    });

    it('returns input unchanged when metadata length exceeds byte length', () => {
      expect(stripMetadata('0x600100ff')).to.equal('600100ff');
    });
  });

  describe('maskRanges', () => {
    it('masks exact windows and clamps to bytecode length', () => {
      expect(
        maskRanges('112233445566', [
          { start: 1, length: 2 },
          { start: 5, length: 4 },
          { start: 9, length: 2 },
        ]),
      ).to.equal('110000445500');
    });
  });

  describe('computeMaskedRuntimeHash', () => {
    it('masks before stripping metadata and hashing', () => {
      const bytecode = '0x1122334455aabb0002';
      const hash = computeMaskedRuntimeHash(
        bytecode,
        [{ start: 1, length: 2 }],
        [],
      );
      expect(hash).to.equal(utils.keccak256('0x1100004455'));
    });
  });

  describe('flattenReferences', () => {
    it('flattens immutable references', () => {
      expect(
        flattenImmutableReferences({
          1: [{ start: 2, length: 3 }],
          2: [{ start: 5, length: 7 }],
        }),
      ).to.deep.equal([
        { start: 2, length: 3 },
        { start: 5, length: 7 },
      ]);
      expect(flattenImmutableReferences(undefined)).to.deep.equal([]);
    });

    it('flattens link references', () => {
      expect(
        flattenLinkReferences({
          'A.sol': {
            LibA: [{ start: 2, length: 20 }],
          },
          'B.sol': {
            LibB: [{ start: 30, length: 20 }],
          },
        }),
      ).to.deep.equal([
        { start: 2, length: 20 },
        { start: 30, length: 20 },
      ]);
      expect(flattenLinkReferences(undefined)).to.deep.equal([]);
    });
  });

  describe('generateManifestFromBuildInfoDir', () => {
    it('keeps duplicate-name candidate from larger build-info', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bytecode-manifest-'));
      try {
        writeJson(path.join(dir, 'small.json'), {
          output: {
            contracts: {
              'Foo.sol': {
                Foo: {
                  evm: { deployedBytecode: { object: '0x6001' } },
                },
              },
            },
          },
        });
        writeJson(path.join(dir, 'large.json'), {
          output: {
            contracts: {
              'Foo.sol': {
                Foo: {
                  evm: { deployedBytecode: { object: '0x6002' } },
                },
              },
              'Bar.sol': {
                Bar: {
                  evm: { deployedBytecode: { object: '0x6003' } },
                },
              },
            },
          },
        });

        const manifest = generateManifestFromBuildInfoDir(dir, '1.0.0');
        expect(manifest.byName.Foo.maskedRuntimeHash).to.equal(
          computeMaskedRuntimeHash('0x6002', [], []),
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('generateManifestFromBuildArtifact', () => {
    const artifact: SolcBuildArtifact = {
      input: {
        language: 'Solidity',
        sources: { 'HypERC20.sol': { content: 'contract HypERC20 {}' } },
        settings: {},
      },
      solcLongVersion: '0.8.19+commit.7dd6d404',
    };

    it('builds byName and byHash from solc output', () => {
      let compileInput = '';
      const manifest = generateManifestFromBuildArtifact(
        artifact,
        '1.0.0',
        (input) => {
          compileInput = input;
          return JSON.stringify({
            contracts: {
              'HypERC20.sol': {
                HypERC20: {
                  evm: {
                    deployedBytecode: {
                      object: '0x6001',
                      immutableReferences: {
                        1: [{ start: 1, length: 1 }],
                      },
                      linkReferences: {},
                    },
                  },
                },
              },
            },
          });
        },
      );

      expect(JSON.parse(compileInput).settings.outputSelection).to.deep.equal({
        '*': {
          '*': [
            'evm.deployedBytecode.object',
            'evm.deployedBytecode.immutableReferences',
            'evm.deployedBytecode.linkReferences',
          ],
        },
      });
      expect(manifest.byName.HypERC20.contractName).to.equal('HypERC20');
      expect(
        manifest.byHash[manifest.byName.HypERC20.maskedRuntimeHash],
      ).to.deep.equal(['HypERC20']);
    });

    it('throws on solc errors', () => {
      expect(() =>
        generateManifestFromBuildArtifact(artifact, '1.0.0', () =>
          JSON.stringify({
            errors: [
              {
                severity: 'error',
                formattedMessage: 'compile failed',
              },
            ],
          }),
        ),
      ).to.throw('compile failed');
    });
  });
});
