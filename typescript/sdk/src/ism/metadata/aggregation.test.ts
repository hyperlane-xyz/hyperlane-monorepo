import { expect } from 'chai';
import { readFileSync, readdirSync } from 'fs';

import {
  AggregationIsmMetadata,
  AggregationIsmMetadataBuilder,
} from './aggregation.js';

type Fixture = AggregationIsmMetadata & {
  encoded: string;
};

const path = '../../solidity/fixtures/aggregation';
const files = readdirSync(path);
const fixtures: Fixture[] = files
  .map((f) => JSON.parse(readFileSync(`${path}/${f}`, 'utf8')))
  .map((contents) => {
    const { encoded, ...values } = contents;
    return {
      encoded,
      submoduleMetadata: Object.values(values),
    };
  });

describe('AggregationMetadataBuilder', () => {
  fixtures.forEach((fixture, i) => {
    it(`should encode fixture ${i}`, () => {
      expect(AggregationIsmMetadataBuilder.encode(fixture)).to.equal(
        fixture.encoded,
      );
    });

    it(`should decode fixture ${i}`, () => {
      expect(
        AggregationIsmMetadataBuilder.decode(
          fixture.encoded,
          fixture.submoduleMetadata.length,
        ).submoduleMetadata,
      ).to.deep.equal(fixture.submoduleMetadata);
    });
  });
});
