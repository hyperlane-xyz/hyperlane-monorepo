import { expect } from 'chai';
import { ethers } from 'ethers';
import { readFileSync, readdirSync } from 'fs';

import { IsmType } from '../types.js';

import {
  AggregationMetadata,
  AggregationMetadataBuilder,
} from './aggregation.js';
import { Fixture } from './types.test.js';

const path = '../../solidity/fixtures/aggregation';
const files = readdirSync(path);
const fixtures: Fixture<AggregationMetadata>[] = files
  .map((f) => JSON.parse(readFileSync(`${path}/${f}`, 'utf8')))
  .map((contents) => {
    const { encoded, ...values } = contents;
    return {
      encoded,
      decoded: {
        type: IsmType.AGGREGATION,
        submoduleMetadata: Object.values(values),
      },
    };
  });

describe('AggregationMetadataBuilder', () => {
  fixtures.forEach((fixture, i) => {
    it(`should encode fixture ${i}`, () => {
      expect(AggregationMetadataBuilder.encode(fixture.decoded)).to.equal(
        fixture.encoded,
      );
    });

    it(`should decode fixture ${i}`, () => {
      const count = fixture.decoded.submoduleMetadata.length;
      expect(
        AggregationMetadataBuilder.decode(fixture.encoded, {} as any, {
          type: IsmType.AGGREGATION,
          modules: new Array(count).fill(ethers.constants.AddressZero),
          threshold: count,
        }),
      ).to.deep.equal(fixture.decoded);
    });
  });
});
