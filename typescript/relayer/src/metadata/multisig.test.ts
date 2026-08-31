import { expect } from 'chai';
import { existsSync, readFileSync, readdirSync } from 'fs';
import sinon from 'sinon';

import {
  GcpValidator,
  HyperlaneCore,
  IsmType,
  ModuleType,
} from '@hyperlane-xyz/sdk';
import { SignatureLike } from '@hyperlane-xyz/utils';

import { MultisigMetadata, MultisigMetadataBuilder } from './multisig.js';
import { Fixture } from './types.test.js';

const path = '../../solidity/fixtures/multisig';
const files = existsSync(path) ? readdirSync(path) : [];
const fixtures: Fixture<MultisigMetadata>[] = files
  .map((f) => JSON.parse(readFileSync(`${path}/${f}`, 'utf8')))
  .map((contents) => {
    const type = contents.type as ModuleType;

    const { dummy: _dummy, ...signatureValues } = contents.signatures;
    const signatures = Object.values<SignatureLike>(signatureValues);

    let decoded: MultisigMetadata;
    if (type === ModuleType.MERKLE_ROOT_MULTISIG) {
      const { dummy: _dummy, ...branchValues } = contents.prefix.proof;
      const branch = Object.values<string>(branchValues);
      decoded = {
        type: IsmType.MERKLE_ROOT_MULTISIG,
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
        type: IsmType.MESSAGE_ID_MULTISIG,
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

class TestMultisigMetadataBuilder extends MultisigMetadataBuilder {
  public constructor(private readonly storageLocations: string[][]) {
    super(sinon.createStubInstance(HyperlaneCore));
  }

  protected override async getAnnouncedStorageLocations(): Promise<string[][]> {
    return this.storageLocations;
  }

  public getCheckpointValidators(originChain: string, validators: string[]) {
    return this.checkpointValidators(originChain, validators);
  }
}

describe('MultisigMetadataBuilder validator storage', () => {
  afterEach(() => sinon.restore());

  it('initializes GCS validators from announced storage locations', async () => {
    const location =
      'gs://hyperlane-mainnet3-validator-0/nesachain/gcsAnnouncementKey';
    const validatorAddress = '0xA5962eFA3ec138Bf7CA8f7fDe86b7ee32E24bf03';
    const validator = new GcpValidator(
      {
        address: validatorAddress,
        localDomain: 41444,
        mailbox: '0x0000000000000000000000000000000000000001',
      },
      {
        bucket: 'hyperlane-mainnet3-validator-0',
        folder: 'nesachain',
        caching: true,
      },
    );
    const fromStorageLocation = sinon
      .stub(GcpValidator, 'fromStorageLocation')
      .resolves(validator);
    const builder = new TestMultisigMetadataBuilder([[location]]);

    expect(
      await builder.getCheckpointValidators('nesachain', [validatorAddress]),
    ).to.deep.equal([validator]);
    expect(fromStorageLocation.calledOnceWithExactly(location)).to.equal(true);
  });
});

// FIXME: migrate to mocha rules
// eslint-disable-next-line jest/no-disabled-tests -- intentionally skipped pending migration
describe.skip('MultisigMetadataBuilder', () => {
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
