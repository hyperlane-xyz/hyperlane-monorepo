import { expect } from 'chai';
import { readFileSync, readdirSync } from 'fs';

import {
  AggregationIsmMetadata,
  AggregationIsmMetadataBuilder,
} from './aggregation.js';

type Fixture = {
  decoded: AggregationIsmMetadata;
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
