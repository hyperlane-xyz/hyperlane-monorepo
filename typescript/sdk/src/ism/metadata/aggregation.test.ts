import { expect } from 'chai';

import {
  AggregationIsmMetadata,
  AggregationIsmMetadataBuilder,
} from './aggregation.js';

type Fixture = {
  decoded: AggregationIsmMetadata;
  encoded: string;
};

const fixtures: Fixture[] = [
  {
    decoded: {
      submoduleMetadata: [
        '290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563',
        '510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9',
        '356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336',
      ],
      count: 3,
    },
    encoded:
      '000000180000003800000038000000580000005800000078290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336',
  },
  {
    decoded: {
      count: 5,
      submoduleMetadata: [
        '290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563',
        '510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9',
        '356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336',
        'f2e59013a0a379837166b59f871b20a8a0d101d1c355ea85d35329360e69c000',
      ],
    },
    encoded:
      '000000280000004800000048000000680000006800000088000000000000000000000088000000a8290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9356e5a2cc1eba076e650ac7473fccc37952b46bc2e419a200cec0c451dce2336f2e59013a0a379837166b59f871b20a8a0d101d1c355ea85d35329360e69c000',
  },
];

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
          fixture.decoded.count,
        ),
      ).to.deep.equal(fixture.decoded);
    });
  });
});
