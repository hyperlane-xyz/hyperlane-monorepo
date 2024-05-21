import { expect } from 'chai';
import { existsSync, readFileSync, readdirSync } from 'fs';

import {
  AggregationIsmMetadata,
  AggregationIsmMetadataBuilder,
} from './aggregation.js';
import { Fixture } from './types.test.js';

const path = '../../solidity/fixtures/aggregation';
const files = existsSync(path) ? readdirSync(path) : [];
const fixtures: Fixture<AggregationIsmMetadata>[] = files
  .map((f) => JSON.parse(readFileSync(`${path}/${f}`, 'utf8')))
  .map((contents) => {
    const { encoded, ...values } = contents;
    return {
      encoded,
      decoded: {
        submoduleMetadata: Object.values(values),
      },
    };
  });

describe('AggregationMetadataBuilder', () => {
  fixtures.forEach((fixture, i) => {
    it(`should encode fixture ${i}`, () => {
      expect(AggregationIsmMetadataBuilder.encode(fixture.decoded)).to.equal(
        fixture.encoded,
      );
    });

    it(`should decode fixture ${i}`, () => {
      expect(
        AggregationIsmMetadataBuilder.decode(
          fixture.encoded,
          fixture.decoded.submoduleMetadata.length,
        ),
      ).to.deep.equal(fixture.decoded);
    });
  });
});
